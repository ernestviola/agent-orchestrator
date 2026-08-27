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
 * Phase 1 scope: the lifecycle only. The "agent process" inside the container is the
 * stub in `sandbox/agent-entrypoint.sh`; there is no orchestrator or model routing.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Docker from 'dockerode';

import { getRoleProfile } from './roles.js';
import {
  DEFAULT_TIMEOUT_MS,
  type AgentResult,
  type AgentStatus,
  type PreparedRun,
  type ResultStore,
  type Role,
  type RoleProfile,
  type RunContext,
  type SpinUpParams,
} from './types.js';

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
  /**
   * @param localRoot  `.orchestrator-runs` as seen by this process.
   * @param hostRoot   `.orchestrator-runs` as the host Docker daemon sees it.
   */
  constructor(
    private readonly localRoot: string,
    private readonly hostRoot: string,
  ) {}

  async prepare(runId: string): Promise<PreparedRun> {
    const inDir = path.join(this.localRoot, runId, 'in');
    const outDir = path.join(this.localRoot, runId, 'out');
    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    // The non-root `agent` user inside the sub-agent writes results here. This is a
    // throwaway per-run directory, so a permissive mode is acceptable.
    await fs.chmod(outDir, 0o777);
    return {
      inDir,
      outDir,
      mountSources: {
        inDir: path.posix.join(this.hostRoot, runId, 'in'),
        outDir: path.posix.join(this.hostRoot, runId, 'out'),
      },
    };
  }

  async finalize(runId: string, ctx: RunContext): Promise<AgentResult> {
    const outDir = path.join(this.localRoot, runId, 'out');
    let status: AgentStatus = ctx.status;
    let summary = '';
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(outDir, 'status.json'), 'utf8')) as {
        summary?: unknown;
      };
      summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    } catch {
      // Exited cleanly but produced no readable result — that is a failure.
      if (status === 'completed') status = 'failed';
    }
    if (!summary) summary = '(no status.json produced by the sub-agent)';
    return {
      runId,
      role: ctx.role,
      status,
      exitCode: ctx.exitCode,
      summary,
      outputDir: outDir,
      startedAt: ctx.startedAt,
      finishedAt: ctx.finishedAt,
    };
  }

  async cleanup(runId: string): Promise<void> {
    await fs.rm(path.join(this.localRoot, runId), { recursive: true, force: true });
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
  hostProjectPath: string;
  mountSources: { inDir: string; outDir: string };
  /** `'none'` for a no-network role, otherwise the per-run internal network name. */
  networkMode: string;
  env: string[];
}

/**
 * Translate a role profile into dockerode container-create options. Pure and
 * synchronous so tests can assert the role → HostConfig mapping exactly.
 */
export function buildAgentCreateOptions(args: AgentCreateArgs): Docker.ContainerCreateOptions {
  const { profile, mountSources, hostProjectPath } = args;
  const binds = [
    ...profile.mounts.map(
      (m) => `${path.posix.join(hostProjectPath, m.hostSubpath)}:${m.containerPath}:${m.mode}`,
    ),
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

  const prepared = await store.prepare(runId);
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

  const hostProjectPath = await resolveProjectHostPath(docker);
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
      );
    }

    res.container = await docker.createContainer(
      buildAgentCreateOptions({
        profile,
        sandboxImage,
        runId,
        hostProjectPath,
        mountSources: prepared.mountSources,
        networkMode,
        env,
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
