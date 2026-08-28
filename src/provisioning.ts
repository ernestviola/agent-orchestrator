/**
 * Container provisioning layer — deterministic code (no LLM) that stands up a real,
 * isolated container per sub-agent task and tears it down afterward.
 *
 * Design constraints (docs/DESIGN.md):
 *   - Role mount / permission profiles come from `src/roles.ts`, not from anything an
 *     LLM controls.
 *   - Sub-agent containers never receive git credentials and never run git.
 *   - Result handoff goes through the `ResultStore` contract — `spinUpAgent` never
 *     reads a shared mount directly — so a cloud backend can replace the local
 *     implementation without changing the interface.
 *
 * Scope: the container lifecycle plus staging a per-run working copy of the target
 * project and returning a diff. The in-container agent runtime (`sandbox/agent.mjs`)
 * handles the engineer and test-engineer roles; the reviewer runtime and the
 * orchestrator loop are not built yet.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import Docker from 'dockerode';

import { selectModel } from './models.js';
import { getRoleProfile } from './roles.js';
import {
  DEFAULT_TIMEOUT_MS,
  type AgentResult,
  type AgentStatus,
  type PrepareOptions,
  type PreparedRun,
  type ProjectManifest,
  type ResultStore,
  type Role,
  type RoleProfile,
  type RunContext,
  type SpinUpParams,
} from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_ITERS = 3;
const MANIFEST_FILE = 'orq-project.json';

const PROXY_ALIAS = 'proxy';
const PROXY_PORT = 8888;
const WORKSPACE_MOUNT = '/workspace';
const RUNS_DIRNAME = '.orchestrator-runs';
const RUN_LABEL = 'orq.run';
const ROLE_LABEL = 'orq.role';

export interface ProvisioningDeps {
  docker: Docker;
  store: ResultStore;
  sandboxImage: string;
  proxyImage: string;
}

// --------------------------------------------------------------------------------------
// Host-path resolution
// --------------------------------------------------------------------------------------

/**
 * Bind-mount sources handed to dockerode are interpreted by the *host* Docker daemon,
 * not by this process's filesystem. When the orchestrator runs inside a container,
 * `/workspace/src` is meaningless to the daemon — it needs the host-absolute path.
 * Resolve it by inspecting our own container's `/workspace` bind mount.
 */
export async function resolveProjectHostPath(docker: Docker): Promise<string> {
  let info: Docker.ContainerInspectInfo;
  try {
    info = await docker.getContainer(os.hostname()).inspect();
  } catch (cause) {
    throw new Error(
      'could not inspect the orchestrator container to resolve the project host path; ' +
        'spinUpAgent must run inside the orchestrator devcontainer',
      { cause },
    );
  }
  const mount = info.Mounts?.find((m) => m.Destination === WORKSPACE_MOUNT);
  if (!mount?.Source) {
    throw new Error(
      `no ${WORKSPACE_MOUNT} bind mount found on this container; cannot resolve the project host path`,
    );
  }
  return mount.Source;
}

// --------------------------------------------------------------------------------------
// Local result store (Phase 1 implementation of the handoff contract)
// --------------------------------------------------------------------------------------

export class LocalResultStore implements ResultStore {
  /** Per-run staging context needed again at `finalize` time (to diff the working copy). */
  private readonly runs = new Map<string, PrepareOptions>();

  /**
   * @param localRoot  `.orchestrator-runs` as seen by this process.
   * @param hostRoot   `.orchestrator-runs` as the host Docker daemon sees it.
   */
  constructor(
    private readonly localRoot: string,
    private readonly hostRoot: string,
  ) {}

  async prepare(runId: string, opts: PrepareOptions): Promise<PreparedRun> {
    const runRoot = path.join(this.localRoot, runId);
    const inDir = path.join(runRoot, 'in');
    const outDir = path.join(runRoot, 'out');
    const workDir = path.join(runRoot, 'work');
    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    // Stage a working copy of the target project — the sub-agent edits this, never
    // the real target. This is also the seam a cloud backend replaces with "seed a
    // volume / object-storage prefix the remote worker reads".
    const origSrc = path.join(opts.projectPath, opts.manifest.srcDir);
    const origTests = path.join(opts.projectPath, opts.manifest.testsDir);
    await fs.cp(origSrc, path.join(workDir, 'src'), { recursive: true });
    await fs.cp(origTests, path.join(workDir, 'tests'), { recursive: true });

    // Writable support paths (e.g. node_modules) — copied so the sub-agent's testCmd
    // can write into them without touching the real target. `cp -a` (fast, preserves
    // symlinks / perms) rather than fs.cp (slow over a big node_modules).
    for (const rel of opts.manifest.sandboxWritablePaths ?? []) {
      const dest = path.join(workDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await execFileAsync('cp', ['-a', path.join(opts.projectPath, rel), dest]);
    }

    // The non-root `agent` user (uid 1000) inside the sub-agent must be able to write
    // its edits and its result. Throwaway per-run dirs, so a permissive mode is fine.
    // The whole working copy is opened up: which subtree is actually writable is
    // decided by the role's bind-mount mode (src/roles.ts), not by these perms.
    await fs.chmod(outDir, 0o777);
    await execFileAsync('chmod', ['-R', 'a+rwX', workDir]);

    this.runs.set(runId, opts);
    return {
      inDir,
      outDir,
      workDir,
      mountSources: {
        inDir: path.posix.join(this.hostRoot, runId, 'in'),
        outDir: path.posix.join(this.hostRoot, runId, 'out'),
        workDir: path.posix.join(this.hostRoot, runId, 'work'),
      },
    };
  }

  async finalize(runId: string, ctx: RunContext): Promise<AgentResult> {
    const runRoot = path.join(this.localRoot, runId);
    const outDir = path.join(runRoot, 'out');
    let status: AgentStatus = ctx.status;
    let summary = '';
    let iterations: number | undefined;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(outDir, 'status.json'), 'utf8')) as {
        summary?: unknown;
        iterations?: unknown;
      };
      summary = typeof parsed.summary === 'string' ? parsed.summary : '';
      if (typeof parsed.iterations === 'number') iterations = parsed.iterations;
    } catch {
      // Exited cleanly but produced no readable result — that is a failure.
      if (status === 'completed') status = 'failed';
    }
    if (!summary) summary = '(no status.json produced by the sub-agent)';

    const diff = await this.computeDiff(runId, runRoot);
    await fs.writeFile(path.join(outDir, 'diff.patch'), diff).catch(() => undefined);

    return {
      runId,
      role: ctx.role,
      status,
      exitCode: ctx.exitCode,
      summary,
      diff,
      iterations,
      outputDir: outDir,
      startedAt: ctx.startedAt,
      finishedAt: ctx.finishedAt,
    };
  }

  async cleanup(runId: string): Promise<void> {
    this.runs.delete(runId);
    await fs.rm(path.join(this.localRoot, runId), { recursive: true, force: true });
  }

  /**
   * Unified diff of the working copy vs the original target, for both `src/` and
   * `tests/`. Only the role's writable subtree can actually differ (engineer →
   * `src/`, test-engineer → `tests/`); the other side contributes an empty string.
   * The staged working copy always uses the fixed names `src` / `tests` (see
   * `prepare`), whatever the manifest calls those dirs in the real target.
   */
  private async computeDiff(runId: string, runRoot: string): Promise<string> {
    const opts = this.runs.get(runId);
    if (!opts) return '';
    const pairs: [orig: string, work: string][] = [
      [path.join(opts.projectPath, opts.manifest.srcDir), path.join(runRoot, 'work', 'src')],
      [path.join(opts.projectPath, opts.manifest.testsDir), path.join(runRoot, 'work', 'tests')],
    ];
    let out = '';
    for (const [orig, work] of pairs) out += await this.diffPair(orig, work);
    return out;
  }

  private async diffPair(orig: string, work: string): Promise<string> {
    try {
      // The orchestrator diffing two local dirs — not a sub-agent git operation.
      const { stdout } = await execFileAsync('git', [
        'diff',
        '--no-index',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        orig,
        work,
      ]);
      return stdout; // exit 0: identical
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      if (e.code === 1) return e.stdout ?? ''; // exit 1: differences (expected)
      throw err; // exit >=2: real failure
    }
  }
}

// --------------------------------------------------------------------------------------
// Deps factory
// --------------------------------------------------------------------------------------

export async function createLocalProvisioningDeps(
  overrides: Partial<ProvisioningDeps> = {},
): Promise<ProvisioningDeps> {
  const docker = overrides.docker ?? new Docker();
  let store = overrides.store;
  if (!store) {
    const hostBase = await resolveProjectHostPath(docker);
    store = new LocalResultStore(
      path.join(process.cwd(), RUNS_DIRNAME),
      path.posix.join(hostBase, RUNS_DIRNAME),
    );
  }
  return {
    docker,
    store,
    sandboxImage: overrides.sandboxImage ?? process.env.ORQ_SANDBOX_IMAGE ?? 'orq-sandbox:dev',
    proxyImage: overrides.proxyImage ?? process.env.ORQ_PROXY_IMAGE ?? 'orq-proxy:dev',
  };
}

// --------------------------------------------------------------------------------------
// Pure container-spec construction (the critical unit-tested seam)
// --------------------------------------------------------------------------------------

export interface AgentCreateArgs {
  profile: RoleProfile;
  sandboxImage: string;
  runId: string;
  /** Host path of the staged working copy (`.orchestrator-runs/<id>/work`). Role
   *  mounts (`src`, `tests`) resolve against this, not the real target. */
  hostWorkspacePath: string;
  mountSources: { inDir: string; outDir: string };
  /** `'none'` for a no-network role, otherwise the per-run internal network name. */
  networkMode: string;
  env: string[];
  /**
   * Extra read-only binds from the *real target project* (not the working copy) —
   * `manifest.sandboxReadonlyPaths` resolved to `{ host source, container target }`.
   * Always `:ro`, so they widen what the sub-agent can read (deps, config) without
   * widening what any role can write.
   */
  readonlyProjectMounts?: { source: string; target: string }[];
  /**
   * `manifest.sandboxWritablePaths` — relative names already `cp -a`'d into the
   * staged working copy by `prepare`. Mounted `:rw` from there (so `testCmd` can
   * write into e.g. `node_modules`), never from the real target.
   */
  writableProjectPaths?: string[];
}

/**
 * Translate a role profile into dockerode container-create options. Pure and
 * synchronous so tests can assert the role → HostConfig mapping exactly.
 */
export function buildAgentCreateOptions(args: AgentCreateArgs): Docker.ContainerCreateOptions {
  const { profile, mountSources, hostWorkspacePath } = args;
  const binds = [
    ...profile.mounts.map(
      (m) => `${path.posix.join(hostWorkspacePath, m.hostSubpath)}:${m.containerPath}:${m.mode}`,
    ),
    ...(args.writableProjectPaths ?? []).map(
      (rel) =>
        `${path.posix.join(hostWorkspacePath, rel)}:${path.posix.join(WORKSPACE_MOUNT, rel)}:rw`,
    ),
    ...(args.readonlyProjectMounts ?? []).map((m) => `${m.source}:${m.target}:ro`),
    `${mountSources.inDir}:/task:ro`,
    `${mountSources.outDir}:/out:rw`,
  ];
  return {
    Image: args.sandboxImage,
    name: `orq-agent-${args.runId}`,
    Labels: { [RUN_LABEL]: args.runId, [ROLE_LABEL]: profile.role },
    Env: args.env,
    Tty: false,
    User: profile.user,
    HostConfig: {
      Binds: binds,
      NetworkMode: args.networkMode,
      CapDrop: [...profile.capDrop],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: profile.readonlyRootfs,
      Tmpfs: { '/tmp': '', '/home/agent/.cache': '' },
      ...(profile.memoryBytes ? { Memory: profile.memoryBytes } : {}),
      ...(profile.pidsLimit ? { PidsLimit: profile.pidsLimit } : {}),
      AutoRemove: false,
    },
  };
}

// --------------------------------------------------------------------------------------
// spinUpAgent / tearDownAgent / reap
// --------------------------------------------------------------------------------------

interface RunResources {
  network?: Docker.Network;
  proxy?: Docker.Container;
  container?: Docker.Container;
}

export async function spinUpAgent(
  params: SpinUpParams,
  deps: ProvisioningDeps,
): Promise<AgentResult> {
  const { docker, store, sandboxImage, proxyImage } = deps;
  const role: Role = params.role;
  const profile = getRoleProfile(role);
  const runId = newRunId();
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await assertImageExists(docker, sandboxImage);
  if (profile.network === 'proxy') await assertImageExists(docker, proxyImage);

  const projectPath = params.projectPath ?? process.cwd();
  const manifest = await loadManifest(projectPath);

  // Resolve `sandboxReadonlyPaths` (deps + config the target's testCmd needs) to
  // real-target host binds. Read-only, so no role gains write access — `src/roles.ts`
  // is untouched. Fail before any Docker resource is created.
  let readonlyProjectMounts: { source: string; target: string }[] = [];
  if (manifest.sandboxReadonlyPaths?.length) {
    const targetHostPath = await resolveTargetHostPath(docker, projectPath);
    readonlyProjectMounts = await Promise.all(
      manifest.sandboxReadonlyPaths.map(async (rel) => {
        assertSafeSandboxPath(rel);
        try {
          await fs.access(path.join(projectPath, rel));
        } catch (cause) {
          throw new Error(
            `${MANIFEST_FILE} lists sandboxReadonlyPaths "${rel}" but it does not exist in ${projectPath} ` +
              '(install the target\'s dependencies first)',
            { cause },
          );
        }
        return {
          source: path.posix.join(targetHostPath, rel.split(path.sep).join('/')),
          target: path.posix.join(WORKSPACE_MOUNT, rel.split(path.sep).join('/')),
        };
      }),
    );
  }

  const prepared = await store.prepare(runId, { projectPath, manifest });
  if (!prepared.mountSources) {
    throw new Error(
      'local provisioning requires ResultStore.prepare() to return mountSources (host bind paths)',
    );
  }
  await fs.writeFile(
    path.join(prepared.inDir, 'task.json'),
    `${JSON.stringify(
      { role, task: params.task.task, context: params.task.context ?? null },
      null,
      2,
    )}\n`,
  );

  // Resolve model credentials up front so a missing key fails before any Docker
  // resources are created. OPENROUTER_API_KEY is a *model* credential — explicitly
  // NOT the git-credential boundary (docs/DESIGN.md). Never log `modelEnv` / `env`.
  let modelEnv: string[] = [];
  if (profile.network === 'proxy') {
    const route = selectModel(role, params.model);
    const apiKey = process.env[route.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `${route.apiKeyEnv} is not set — the ${role} sub-agent needs it to reach the model. ` +
          `Add it to .env.local.`,
      );
    }
    modelEnv = [
      `${route.apiKeyEnv}=${apiKey}`,
      `ORQ_MODEL=${route.model}`,
      `ORQ_MODEL_BASE_URL=${route.baseUrl}`,
      `ORQ_TEST_CMD=${manifest.testCmd}`,
      `ORQ_MAX_ITERS=${DEFAULT_MAX_ITERS}`,
    ];
  }

  const startedAt = new Date().toISOString();
  const res: RunResources = {};
  let status: AgentStatus = 'failed';
  let exitCode: number | null = null;

  try {
    let networkMode = 'none';
    const env: string[] = [];

    if (profile.network === 'proxy') {
      res.network = await docker.createNetwork({
        Name: `orq-${runId}`,
        Driver: 'bridge',
        Internal: true,
        Labels: { [RUN_LABEL]: runId },
      });
      res.proxy = await docker.createContainer({
        Image: proxyImage,
        name: `orq-proxy-${runId}`,
        Labels: { [RUN_LABEL]: runId, [ROLE_LABEL]: 'proxy' },
        HostConfig: {
          NetworkMode: 'bridge', // egress path for the proxy itself
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          AutoRemove: false,
        },
      });
      await res.proxy.start();
      await res.network.connect({
        Container: res.proxy.id,
        EndpointConfig: { Aliases: [PROXY_ALIAS] },
      });
      networkMode = `orq-${runId}`;
      const url = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
      env.push(
        `HTTP_PROXY=${url}`,
        `HTTPS_PROXY=${url}`,
        `http_proxy=${url}`,
        `https_proxy=${url}`,
        'NO_PROXY=localhost,127.0.0.1',
        'no_proxy=localhost,127.0.0.1',
        ...modelEnv,
      );
    }

    res.container = await docker.createContainer(
      buildAgentCreateOptions({
        profile,
        sandboxImage,
        runId,
        hostWorkspacePath: prepared.mountSources.workDir,
        mountSources: prepared.mountSources,
        networkMode,
        env,
        readonlyProjectMounts,
        writableProjectPaths: manifest.sandboxWritablePaths ?? [],
      }),
    );

    await res.container.start();

    const exited = res.container.wait();
    const outcome = await Promise.race([
      exited.then(() => 'exited' as const),
      sleep(timeoutMs).then(() => 'timeout' as const),
    ]);

    if (outcome === 'timeout') {
      status = 'timeout';
      // Stop waiting on wait() — teardown's forced remove handles a live container.
      exited.catch(() => undefined);
      await safe(() => res.container!.kill());
    } else {
      const info = await res.container.inspect();
      exitCode = info.State?.ExitCode ?? null;
      status = exitCode === 0 ? 'completed' : 'failed';
    }

    await safe(async () => {
      const raw = (await res.container!.logs({
        stdout: true,
        stderr: true,
        follow: false,
      })) as unknown as Buffer;
      await fs.writeFile(path.join(prepared.outDir, 'container.log'), demuxDockerLogs(raw));
    });
  } finally {
    await teardownResources(res);
  }

  const ctx: RunContext = {
    role,
    status,
    exitCode,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  return store.finalize(runId, ctx);
}

/**
 * Explicit cleanup of a run's *result* directory plus any lingering labeled
 * container / network. `spinUpAgent` already removes the container/proxy/network in
 * its `finally`; it deliberately leaves the result dir so the caller can inspect it,
 * so call this once the `AgentResult` has been consumed.
 */
export async function tearDownAgent(runId: string, deps: ProvisioningDeps): Promise<void> {
  const { docker, store } = deps;
  await removeLabeled(docker, runId);
  await safe(() => store.cleanup(runId));
}

/** Sweep every orphaned orchestrator-provisioned container / network (crash recovery). */
export async function reap(deps: ProvisioningDeps): Promise<{ containers: number; networks: number }> {
  const { docker } = deps;
  const containers = await docker.listContainers({ all: true, filters: { label: [RUN_LABEL] } });
  for (const c of containers) {
    await safe(() => docker.getContainer(c.Id).remove({ force: true }));
  }
  const networks = await docker.listNetworks({ filters: { label: [RUN_LABEL] } });
  for (const n of networks) {
    await safe(() => docker.getNetwork(n.Id).remove());
  }
  return { containers: containers.length, networks: networks.length };
}

// --------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------

function newRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

async function loadManifest(projectPath: string): Promise<ProjectManifest> {
  const file = path.join(projectPath, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (cause) {
    throw new Error(`target project has no ${MANIFEST_FILE} at ${projectPath}`, { cause });
  }
  const parsed = JSON.parse(raw) as Partial<ProjectManifest>;
  for (const key of ['testCmd', 'srcDir', 'testsDir'] as const) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) {
      throw new Error(`${MANIFEST_FILE} is missing a valid "${key}"`);
    }
  }
  for (const key of ['sandboxReadonlyPaths', 'sandboxWritablePaths'] as const) {
    const val = parsed[key];
    if (val === undefined) continue;
    if (!Array.isArray(val) || !val.every((p) => typeof p === 'string')) {
      throw new Error(`${MANIFEST_FILE}: "${key}" must be an array of strings`);
    }
    for (const p of val) assertSafeSandboxPath(p);
  }
  const overlap = (parsed.sandboxReadonlyPaths ?? []).filter((p) =>
    (parsed.sandboxWritablePaths ?? []).includes(p),
  );
  if (overlap.length) {
    throw new Error(
      `${MANIFEST_FILE}: "${overlap[0]}" is in both sandboxReadonlyPaths and sandboxWritablePaths`,
    );
  }
  return parsed as ProjectManifest;
}

/** Sensitive-file patterns a `sandboxReadonlyPaths` entry must not match (mirrors AGENTS.md §6). */
const SECRETISH = /(^|[/.])(\.env|.*secret.*|.*credential.*|.*token.*)|\.(pem|key|p12|pfx)$|(^|\/)\.git(\/|$)/i;

/**
 * Guard for a `sandboxReadonlyPaths` entry: a plain relative path inside the target
 * project, never a credential file. Throws with a clear message; exported for tests.
 */
export function assertSafeSandboxPath(rel: string): void {
  if (!rel || typeof rel !== 'string') {
    throw new Error(`${MANIFEST_FILE}: sandboxReadonlyPaths entry must be a non-empty string`);
  }
  if (path.isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) {
    throw new Error(
      `${MANIFEST_FILE}: sandboxReadonlyPaths entry "${rel}" must be a relative path within the project (no "..", no leading "/")`,
    );
  }
  if (SECRETISH.test(rel)) {
    throw new Error(
      `${MANIFEST_FILE}: refusing to mount "${rel}" into a sub-agent — it looks like a credential file`,
    );
  }
}

/**
 * Host-daemon path of a target project that lives inside the orchestrator's
 * `/workspace`. Built from the orchestrator's own `/workspace` bind mount plus the
 * target's subpath. Throws for a target outside `/workspace` (only in-repo targets
 * are supported). Assumes the orchestrator process runs with its cwd under
 * `/workspace` (it does, via the npm scripts).
 */
export async function resolveTargetHostPath(docker: Docker, projectPath: string): Promise<string> {
  const base = await resolveProjectHostPath(docker);
  const rel = path.relative(WORKSPACE_MOUNT, path.resolve(projectPath));
  if (rel === '') return base;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `target project "${projectPath}" is outside the orchestrator's ${WORKSPACE_MOUNT}; ` +
        'only in-repo targets are supported',
    );
  }
  return path.posix.join(base, rel.split(path.sep).join('/'));
}

async function assertImageExists(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch (cause) {
    throw new Error(`sub-agent image "${image}" not found — run \`npm run sandbox:build\``, { cause });
  }
}

async function teardownResources(res: RunResources): Promise<void> {
  if (res.container) await safe(() => res.container!.remove({ force: true }));
  if (res.proxy) await safe(() => res.proxy!.remove({ force: true }));
  if (res.network) await safe(() => res.network!.remove());
}

async function removeLabeled(docker: Docker, runId: string): Promise<void> {
  const containers = await docker
    .listContainers({ all: true, filters: { label: [`${RUN_LABEL}=${runId}`] } })
    .catch(() => [] as Docker.ContainerInfo[]);
  for (const c of containers) {
    await safe(() => docker.getContainer(c.Id).remove({ force: true }));
  }
  const networks = await docker
    .listNetworks({ filters: { label: [`${RUN_LABEL}=${runId}`] } })
    .catch(() => [] as Docker.NetworkInspectInfo[]);
  for (const n of networks) {
    await safe(() => docker.getNetwork(n.Id).remove());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

async function safe<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * Docker's non-TTY log stream frames each chunk with an 8-byte header
 * `[stream, 0,0,0, size(uint32 BE)]`. Concatenate the payloads; fall back to raw text
 * if the buffer was never framed.
 */
export function demuxDockerLogs(buf: Buffer): string {
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break;
    out += buf.toString('utf8', start, end);
    i = end;
  }
  return out || buf.toString('utf8');
}
