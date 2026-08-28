import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRoleProfile } from '../src/roles.js';
import {
  LocalResultStore,
  assertSafeSandboxPath,
  buildAgentCreateOptions,
  demuxDockerLogs,
  resolveProjectHostPath,
  resolveTargetHostPath,
  spinUpAgent,
  type ProvisioningDeps,
} from '../src/provisioning.js';
import type {
  PrepareOptions,
  PreparedRun,
  ProjectManifest,
  ResultStore,
  RunContext,
} from '../src/types.js';

const FIXTURE = path.join(process.cwd(), 'fixtures', 'sample-project');
const MANIFEST: ProjectManifest = { testCmd: 'node --test', srcDir: 'src', testsDir: 'tests' };

/**
 * `LocalResultStore.finalize` shells out to `git diff --no-index` (a local diffing
 * tool, not a repo op). The orchestrator container has git; a sub-agent sandbox
 * deliberately does not, so these run in CI / dev and skip when self-hosting.
 */
const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// --------------------------------------------------------------------------------------
// buildAgentCreateOptions — the role -> HostConfig mapping (pure, no Docker)
// --------------------------------------------------------------------------------------

const WORK = '/host/.runs/r1/work';
const MS = { inDir: '/host/.runs/r1/in', outDir: '/host/.runs/r1/out' };

function opts(role: Parameters<typeof getRoleProfile>[0], networkMode = 'none', env: string[] = []) {
  return buildAgentCreateOptions({
    profile: getRoleProfile(role),
    sandboxImage: 'orq-sandbox:dev',
    runId: 'r1',
    hostWorkspacePath: WORK,
    mountSources: MS,
    networkMode,
    env,
  });
}

describe('buildAgentCreateOptions', () => {
  it('always applies the hardening flags and the per-run in/out mounts', () => {
    for (const role of ['test-engineer', 'engineer', 'reviewer'] as const) {
      const o = opts(role);
      expect(o.User).toBe('agent');
      expect(o.Tty).toBe(false);
      expect(o.HostConfig?.CapDrop).toEqual(['ALL']);
      expect(o.HostConfig?.SecurityOpt).toEqual(['no-new-privileges']);
      expect(o.HostConfig?.ReadonlyRootfs).toBe(true);
      expect(o.HostConfig?.AutoRemove).toBe(false);
      expect(o.HostConfig?.Binds).toContain(`${MS.inDir}:/task:ro`);
      expect(o.HostConfig?.Binds).toContain(`${MS.outDir}:/out:rw`);
      expect(o.Labels?.['orq.run']).toBe('r1');
      expect(o.Labels?.['orq.role']).toBe(role);
    }
  });

  it('resolves project mounts against the staged working copy, not the real target', () => {
    const binds = opts('engineer').HostConfig?.Binds ?? [];
    expect(binds).toContain(`${WORK}/src:/workspace/src:rw`);
  });

  it('engineer: src/ read-write, tests/ read-only', () => {
    const binds = opts('engineer').HostConfig?.Binds ?? [];
    expect(binds).toContain(`${WORK}/src:/workspace/src:rw`);
    expect(binds).toContain(`${WORK}/tests:/workspace/tests:ro`);
    expect(binds.some((b) => b.includes('/workspace/tests') && b.endsWith(':rw'))).toBe(false);
  });

  it('test-engineer: tests/ read-write, src/ read-only', () => {
    const binds = opts('test-engineer').HostConfig?.Binds ?? [];
    expect(binds).toContain(`${WORK}/tests:/workspace/tests:rw`);
    expect(binds).toContain(`${WORK}/src:/workspace/src:ro`);
  });

  it('reviewer: every project mount read-only', () => {
    const binds = (opts('reviewer').HostConfig?.Binds ?? []).filter((b) => b.includes('/workspace/'));
    expect(binds.length).toBeGreaterThan(0);
    expect(binds.every((b) => b.endsWith(':ro'))).toBe(true);
  });

  it('passes the network mode and env straight through', () => {
    const o = opts('engineer', 'orq-r1', ['HTTP_PROXY=http://proxy:8888']);
    expect(o.HostConfig?.NetworkMode).toBe('orq-r1');
    expect(o.Env).toContain('HTTP_PROXY=http://proxy:8888');
  });

  it('appends readonlyProjectMounts as :ro binds and leaves them out when absent', () => {
    expect(opts('engineer').HostConfig?.Binds).not.toContain(
      '/t/node_modules:/workspace/node_modules:ro',
    );
    const o = buildAgentCreateOptions({
      profile: getRoleProfile('engineer'),
      sandboxImage: 'orq-sandbox:dev',
      runId: 'r1',
      hostWorkspacePath: WORK,
      mountSources: MS,
      networkMode: 'none',
      env: [],
      readonlyProjectMounts: [
        { source: '/t/node_modules', target: '/workspace/node_modules' },
        { source: '/t/package.json', target: '/workspace/package.json' },
      ],
    });
    const binds = o.HostConfig?.Binds ?? [];
    expect(binds).toContain('/t/node_modules:/workspace/node_modules:ro');
    expect(binds).toContain('/t/package.json:/workspace/package.json:ro');
    // still after the role mount, before /task + /out
    expect(binds.indexOf('/t/node_modules:/workspace/node_modules:ro')).toBeLessThan(
      binds.indexOf(`${MS.inDir}:/task:ro`),
    );
  });
});

// --------------------------------------------------------------------------------------
// demuxDockerLogs
// --------------------------------------------------------------------------------------

describe('demuxDockerLogs', () => {
  it('concatenates framed stdout/stderr payloads', () => {
    const frame = (stream: number, text: string) => {
      const body = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(body.length, 4);
      return Buffer.concat([header, body]);
    };
    const buf = Buffer.concat([frame(1, 'hello '), frame(2, 'world')]);
    expect(demuxDockerLogs(buf)).toBe('hello world');
  });

  it('falls back to raw text when the buffer is not framed', () => {
    expect(demuxDockerLogs(Buffer.from('plain output'))).toBe('plain output');
  });
});

// --------------------------------------------------------------------------------------
// resolveProjectHostPath
// --------------------------------------------------------------------------------------

describe('resolveProjectHostPath', () => {
  it('returns the Source of the /workspace bind mount on the current container', async () => {
    const docker = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Mounts: [
            { Destination: '/etc/foo', Source: '/x' },
            { Destination: '/workspace', Source: '/Users/dev/proj' },
          ],
        }),
      }),
    } as never;
    await expect(resolveProjectHostPath(docker)).resolves.toBe('/Users/dev/proj');
  });

  it('throws when there is no /workspace mount', async () => {
    const docker = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Mounts: [] }),
      }),
    } as never;
    await expect(resolveProjectHostPath(docker)).rejects.toThrow(/no \/workspace bind mount/);
  });
});

// --------------------------------------------------------------------------------------
// assertSafeSandboxPath
// --------------------------------------------------------------------------------------

describe('assertSafeSandboxPath', () => {
  it.each(['node_modules', 'package.json', 'package-lock.json', 'tsconfig.test.json', 'vitest.config.ts', 'config/app.json'])(
    'accepts %s',
    (p) => {
      expect(() => assertSafeSandboxPath(p)).not.toThrow();
    },
  );

  it.each(['/etc/passwd', '../outside', 'a/../b', 'x/../../y'])('rejects the traversal %s', (p) => {
    expect(() => assertSafeSandboxPath(p)).toThrow(/relative path within the project/);
  });

  it.each(['.env', '.env.local', 'config/.env', 'server.pem', 'id.key', 'my-secret.json', 'auth-token.txt', 'aws.credentials', '.git/config'])(
    'rejects the credential-ish path %s',
    (p) => {
      expect(() => assertSafeSandboxPath(p)).toThrow(/credential file|relative path within the project/);
    },
  );
});

// --------------------------------------------------------------------------------------
// resolveTargetHostPath
// --------------------------------------------------------------------------------------

describe('resolveTargetHostPath', () => {
  const docker = {
    getContainer: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Mounts: [{ Destination: '/workspace', Source: '/host/proj' }] }),
    }),
  } as never;

  it('returns the orchestrator host path for the repo root itself', async () => {
    await expect(resolveTargetHostPath(docker, '/workspace')).resolves.toBe('/host/proj');
  });

  it('joins the subpath for an in-repo target', async () => {
    await expect(resolveTargetHostPath(docker, '/workspace/fixtures/sample-project')).resolves.toBe(
      '/host/proj/fixtures/sample-project',
    );
  });

  it('throws for a target outside /workspace', async () => {
    await expect(resolveTargetHostPath(docker, '/etc')).rejects.toThrow(/only in-repo targets/);
  });
});

// --------------------------------------------------------------------------------------
// LocalResultStore
// --------------------------------------------------------------------------------------

describe('LocalResultStore', () => {
  let root: string;
  let project: string;
  const prepOpts = (): PrepareOptions => ({ projectPath: project, manifest: MANIFEST });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-store-'));
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-proj-'));
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(path.join(project, 'tests'), { recursive: true });
    await fs.writeFile(path.join(project, 'src', 'a.mjs'), 'export const a = 1;\n');
    await fs.writeFile(path.join(project, 'tests', 'a.test.mjs'), '// t\n');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  });

  it('prepare creates in/out/work dirs, stages the working copy, and returns host mount sources', async () => {
    const store = new LocalResultStore(root, '/host/.orchestrator-runs');
    const p = await store.prepare('run7', prepOpts());
    expect((await fs.stat(p.inDir)).isDirectory()).toBe(true);
    expect((await fs.stat(p.outDir)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(p.workDir, 'src', 'a.mjs'), 'utf8')).toBe('export const a = 1;\n');
    expect(await fs.readFile(path.join(p.workDir, 'tests', 'a.test.mjs'), 'utf8')).toBe('// t\n');
    expect(p.mountSources).toEqual({
      inDir: '/host/.orchestrator-runs/run7/in',
      outDir: '/host/.orchestrator-runs/run7/out',
      workDir: '/host/.orchestrator-runs/run7/work',
    });
  });

  it.skipIf(!HAS_GIT)('finalize reads the summary + iterations the sub-agent wrote, with an empty diff for an untouched copy', async () => {
    const store = new LocalResultStore(root, '/host');
    const p = await store.prepare('run8', prepOpts());
    await fs.writeFile(
      path.join(p.outDir, 'status.json'),
      JSON.stringify({ summary: 'did the thing', iterations: 2 }),
    );
    const r = await store.finalize('run8', ctx('completed', 0));
    expect(r.summary).toBe('did the thing');
    expect(r.iterations).toBe(2);
    expect(r.status).toBe('completed');
    expect(r.diff).toBe('');
    expect(r.outputDir).toBe(p.outDir);
  });

  it.skipIf(!HAS_GIT)('finalize returns a unified diff when the working copy of src/ changed', async () => {
    const store = new LocalResultStore(root, '/host');
    const p = await store.prepare('run8b', prepOpts());
    await fs.writeFile(path.join(p.workDir, 'src', 'a.mjs'), 'export const a = 42;\n');
    await fs.writeFile(path.join(p.outDir, 'status.json'), JSON.stringify({ summary: 's' }));
    const r = await store.finalize('run8b', ctx('completed', 0));
    expect(r.diff).toMatch(/a\.mjs/);
    expect(r.diff).toMatch(/-export const a = 1;/);
    expect(r.diff).toMatch(/\+export const a = 42;/);
    expect(await fs.readFile(path.join(p.outDir, 'diff.patch'), 'utf8')).toBe(r.diff);
  });

  it.skipIf(!HAS_GIT)('finalize returns a unified diff when the working copy of tests/ changed', async () => {
    const store = new LocalResultStore(root, '/host');
    const p = await store.prepare('run8c', prepOpts());
    await fs.writeFile(path.join(p.workDir, 'tests', 'a.test.mjs'), '// new assertions\n');
    await fs.writeFile(path.join(p.outDir, 'status.json'), JSON.stringify({ summary: 's' }));
    const r = await store.finalize('run8c', {
      role: 'test-engineer',
      status: 'completed',
      exitCode: 0,
      startedAt: 'a',
      finishedAt: 'b',
    });
    expect(r.diff).toMatch(/a\.test\.mjs/);
    expect(r.diff).toMatch(/-\/\/ t/);
    expect(r.diff).toMatch(/\+\/\/ new assertions/);
    expect(await fs.readFile(path.join(p.outDir, 'diff.patch'), 'utf8')).toBe(r.diff);
  });

  it.skipIf(!HAS_GIT)('finalize downgrades a clean exit to "failed" when no status.json was produced', async () => {
    const store = new LocalResultStore(root, '/host');
    await store.prepare('run9', prepOpts());
    const r = await store.finalize('run9', ctx('completed', 0));
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/no status\.json/);
  });

  it('cleanup removes the run directory', async () => {
    const store = new LocalResultStore(root, '/host');
    const p = await store.prepare('run10', prepOpts());
    await store.cleanup('run10');
    await expect(fs.stat(path.dirname(p.inDir))).rejects.toThrow();
  });

  function ctx(status: RunContext['status'], exitCode: number | null): RunContext {
    return { role: 'engineer', status, exitCode, startedAt: 'a', finishedAt: 'b' };
  }
});

// --------------------------------------------------------------------------------------
// spinUpAgent — lifecycle, with dockerode fully mocked
// --------------------------------------------------------------------------------------

class FakeStore implements ResultStore {
  prepared: string[] = [];
  finalized: RunContext[] = [];
  cleaned: string[] = [];
  constructor(private root: string) {}
  async prepare(runId: string, _opts: PrepareOptions): Promise<PreparedRun> {
    void _opts;
    const inDir = path.join(this.root, runId, 'in');
    const outDir = path.join(this.root, runId, 'out');
    const workDir = path.join(this.root, runId, 'work');
    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    this.prepared.push(runId);
    return {
      inDir,
      outDir,
      workDir,
      mountSources: {
        inDir: `/host/${runId}/in`,
        outDir: `/host/${runId}/out`,
        workDir: `/host/${runId}/work`,
      },
    };
  }
  async finalize(runId: string, ctx: RunContext) {
    this.finalized.push(ctx);
    return {
      runId,
      role: ctx.role,
      status: ctx.status,
      exitCode: ctx.exitCode,
      summary: 'fake-summary',
      diff: '',
      outputDir: path.join(this.root, runId, 'out'),
      startedAt: ctx.startedAt,
      finishedAt: ctx.finishedAt,
    };
  }
  async cleanup(runId: string) {
    this.cleaned.push(runId);
  }
}

interface FakeContainer {
  id: string;
  start: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function makeContainer(
  over: Partial<{ exitCode: number; wait: ReturnType<typeof vi.fn> }> = {},
): FakeContainer {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    start: vi.fn().mockResolvedValue(undefined),
    wait: over.wait ?? vi.fn().mockResolvedValue({ StatusCode: over.exitCode ?? 0 }),
    inspect: vi.fn().mockResolvedValue({ State: { ExitCode: over.exitCode ?? 0 } }),
    logs: vi.fn().mockResolvedValue(Buffer.from('')),
    kill: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(root: string) {
  const network = {
    id: 'net-1',
    connect: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const created: { name?: string; opts: unknown }[] = [];
  const containers: FakeContainer[] = [];

  const docker = {
    getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
    getContainer: vi.fn().mockImplementation((id: string) => {
      if (id === os.hostname()) {
        return {
          inspect: vi.fn().mockResolvedValue({
            Mounts: [{ Destination: '/workspace', Source: '/host/project' }],
          }),
        };
      }
      return containers.find((c) => c.id === id) ?? makeContainer();
    }),
    createNetwork: vi.fn().mockResolvedValue(network),
    createContainer: vi.fn().mockImplementation((o: { name?: string }) => {
      const c = makeContainer();
      containers.push(c);
      created.push({ name: o.name, opts: o });
      return Promise.resolve(c);
    }),
    listContainers: vi.fn().mockResolvedValue([]),
    listNetworks: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue(undefined) }),
  };

  const store = new FakeStore(root);
  const deps = {
    docker: docker as never,
    store,
    sandboxImage: 'orq-sandbox:dev',
    proxyImage: 'orq-proxy:dev',
  } satisfies ProvisioningDeps;
  return { deps, docker, store, network, created, containers };
}

const envArr = (c: { opts: unknown }) => (c.opts as { Env: string[] }).Env;
const netMode = (c: { opts: unknown }) =>
  (c.opts as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode;

describe('spinUpAgent', () => {
  let root: string;
  const KEY = 'OPENROUTER_API_KEY';
  let savedKey: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-run-'));
    savedKey = process.env[KEY];
    process.env[KEY] = 'test-key';
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env[KEY];
    else process.env[KEY] = savedKey;
    vi.restoreAllMocks();
  });

  it('engineer: per-run proxy + internal network, injects proxy + model env, tears them down', async () => {
    const { deps, docker, store, network, created, containers } = makeDeps(root);

    const result = await spinUpAgent(
      { role: 'engineer', task: { task: 'do X' }, projectPath: FIXTURE },
      deps,
    );

    expect(docker.createNetwork).toHaveBeenCalledOnce();
    const proxy = created.find((c) => c.name?.startsWith('orq-proxy-'));
    const agent = created.find((c) => c.name?.startsWith('orq-agent-'));
    expect(proxy).toBeTruthy();
    expect(agent).toBeTruthy();
    expect(network.connect).toHaveBeenCalledWith(
      expect.objectContaining({ EndpointConfig: { Aliases: ['proxy'] } }),
    );

    const env = envArr(agent!);
    expect(env).toContain('HTTP_PROXY=http://proxy:8888');
    expect(env).toContain('OPENROUTER_API_KEY=test-key');
    expect(env).toContain('ORQ_TEST_CMD=node --test');
    expect(env.some((e) => e.startsWith('ORQ_MODEL='))).toBe(true);
    expect(netMode(agent!)).toMatch(/^orq-/);

    const taskJson = JSON.parse(
      await fs.readFile(path.join(root, store.prepared[0]!, 'in', 'task.json'), 'utf8'),
    );
    expect(taskJson).toMatchObject({ role: 'engineer', task: 'do X' });

    for (const c of containers) expect(c.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();

    expect(store.finalized).toHaveLength(1);
    expect(store.finalized[0]).toMatchObject({ role: 'engineer', status: 'completed', exitCode: 0 });
    expect(store.cleaned).toEqual([]);
    expect(result.status).toBe('completed');
  });

  it('test-engineer: same proxy + internal network + model env wiring as engineer', async () => {
    const { deps, docker, store, created } = makeDeps(root);

    const result = await spinUpAgent(
      { role: 'test-engineer', task: { task: 'write tests for fizzbuzz' }, projectPath: FIXTURE },
      deps,
    );

    expect(docker.createNetwork).toHaveBeenCalledOnce();
    const agent = created.find((c) => c.name?.startsWith('orq-agent-'));
    expect(agent).toBeTruthy();

    const env = envArr(agent!);
    expect(env).toContain('HTTP_PROXY=http://proxy:8888');
    expect(env).toContain('OPENROUTER_API_KEY=test-key');
    expect(env.some((e) => e.startsWith('ORQ_MODEL='))).toBe(true);
    expect(netMode(agent!)).toMatch(/^orq-/);

    const taskJson = JSON.parse(
      await fs.readFile(path.join(root, store.prepared[0]!, 'in', 'task.json'), 'utf8'),
    );
    expect(taskJson).toMatchObject({ role: 'test-engineer', task: 'write tests for fizzbuzz' });

    expect(store.finalized[0]).toMatchObject({ role: 'test-engineer', status: 'completed' });
    expect(result.status).toBe('completed');
  });

  it('throws a clear error when OPENROUTER_API_KEY is unset', async () => {
    delete process.env[KEY];
    const { deps } = makeDeps(root);
    await expect(
      spinUpAgent({ role: 'engineer', task: { task: 'x' }, projectPath: FIXTURE }, deps),
    ).rejects.toThrow(/OPENROUTER_API_KEY is not set/);
  });

  // fixtures/node-runtime-project has sandboxReadonlyPaths:["package.json"] + sandboxWritablePaths:["vendor"]
  const NODE_FIXTURE = path.join(process.cwd(), 'fixtures', 'node-runtime-project');

  it('mounts sandboxReadonlyPaths :ro from the real target and sandboxWritablePaths :rw from the working copy', async () => {
    const { deps, created } = makeDeps(root);

    await spinUpAgent({ role: 'engineer', task: { task: 'x' }, projectPath: NODE_FIXTURE }, deps);

    const agent = created.find((c) => c.name?.startsWith('orq-agent-'))!;
    const binds = (agent.opts as { HostConfig: { Binds: string[] } }).HostConfig.Binds;
    // mock docker reports the orchestrator's /workspace host path as /host/project
    expect(binds).toContain(
      '/host/project/fixtures/node-runtime-project/package.json:/workspace/package.json:ro',
    );
    // writable path is mounted from the staged working copy, not the real target
    const workVendor = binds.find((b) => b.endsWith(':/workspace/vendor:rw'));
    expect(workVendor).toBeDefined();
    expect(workVendor).not.toContain('/fixtures/node-runtime-project/');
  });

  it('fails before creating Docker resources when a sandboxReadonlyPaths entry is missing', async () => {
    const { deps, docker } = makeDeps(root);
    vi.spyOn(fs, 'access').mockRejectedValueOnce(new Error('ENOENT'));

    await expect(
      spinUpAgent({ role: 'engineer', task: { task: 'x' }, projectPath: NODE_FIXTURE }, deps),
    ).rejects.toThrow(/sandboxReadonlyPaths "package\.json" but it does not exist/);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('reviewer: no network, no proxy, no model env', async () => {
    const { deps, docker, created } = makeDeps(root);
    await spinUpAgent(
      { role: 'reviewer', task: { task: 'review the diff' }, projectPath: FIXTURE },
      deps,
    );

    expect(docker.createNetwork).not.toHaveBeenCalled();
    expect(created.some((c) => c.name?.startsWith('orq-proxy-'))).toBe(false);
    const agent = created.find((c) => c.name?.startsWith('orq-agent-'))!;
    expect(netMode(agent)).toBe('none');
    expect(envArr(agent)).toEqual([]);
  });

  it('a non-zero container exit yields status "failed"', async () => {
    const { deps, docker } = makeDeps(root);
    docker.createContainer.mockImplementation((o: { name?: string }) => {
      const c = makeContainer({ exitCode: o.name?.startsWith('orq-agent-') ? 3 : 0 });
      return Promise.resolve(c);
    });
    const result = await spinUpAgent(
      { role: 'engineer', task: { task: 'x' }, projectPath: FIXTURE },
      deps,
    );
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
  });

  it('kills the container and reports "timeout" when it overruns', async () => {
    const { deps, docker, containers } = makeDeps(root);
    docker.createContainer.mockImplementation((o: { name?: string }) => {
      const c = makeContainer({
        wait: o.name?.startsWith('orq-agent-')
          ? vi.fn().mockReturnValue(new Promise(() => {}))
          : undefined,
      });
      containers.push(c);
      return Promise.resolve(c);
    });

    const result = await spinUpAgent(
      { role: 'reviewer', task: { task: 'x' }, projectPath: FIXTURE, timeoutMs: 20 },
      deps,
    );

    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(containers.some((c) => c.kill.mock.calls.length > 0)).toBe(true);
  });

  it('throws a build hint when the sandbox image is missing', async () => {
    const { deps, docker } = makeDeps(root);
    docker.getImage.mockReturnValue({ inspect: vi.fn().mockRejectedValue(new Error('404')) });
    await expect(
      spinUpAgent({ role: 'engineer', task: { task: 'x' }, projectPath: FIXTURE }, deps),
    ).rejects.toThrow(/npm run sandbox:build/);
  });

  it('still tears down resources when the container fails to start', async () => {
    const { deps, docker, network, containers } = makeDeps(root);
    docker.createContainer.mockImplementation((o: { name?: string }) => {
      const c = makeContainer();
      if (o.name?.startsWith('orq-agent-')) {
        c.start = vi.fn().mockRejectedValue(new Error('boom'));
      }
      containers.push(c);
      return Promise.resolve(c);
    });

    await expect(
      spinUpAgent({ role: 'engineer', task: { task: 'x' }, projectPath: FIXTURE }, deps),
    ).rejects.toThrow('boom');
    for (const c of containers) expect(c.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();
  });
});
