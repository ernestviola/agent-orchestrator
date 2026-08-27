import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRoleProfile } from '../src/roles.js';
import {
  LocalResultStore,
  buildAgentCreateOptions,
  demuxDockerLogs,
  resolveProjectHostPath,
  spinUpAgent,
  type ProvisioningDeps,
} from '../src/provisioning.js';
import type { PreparedRun, ResultStore, RunContext } from '../src/types.js';

// --------------------------------------------------------------------------------------
// buildAgentCreateOptions — the role -> HostConfig mapping (pure, no Docker)
// --------------------------------------------------------------------------------------

const HOST = '/host/project';
const MS = { inDir: '/host/.runs/r1/in', outDir: '/host/.runs/r1/out' };

function opts(role: Parameters<typeof getRoleProfile>[0], networkMode = 'none', env: string[] = []) {
  return buildAgentCreateOptions({
    profile: getRoleProfile(role),
    sandboxImage: 'orq-sandbox:dev',
    runId: 'r1',
    hostProjectPath: HOST,
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

  it('engineer: src/ read-write, tests/ not mounted', () => {
    const binds = opts('engineer').HostConfig?.Binds ?? [];
    expect(binds).toContain(`${HOST}/src:/workspace/src:rw`);
    expect(binds.some((b) => b.includes('/workspace/tests'))).toBe(false);
  });

  it('test-engineer: tests/ read-write, src/ read-only', () => {
    const binds = opts('test-engineer').HostConfig?.Binds ?? [];
    expect(binds).toContain(`${HOST}/tests:/workspace/tests:rw`);
    expect(binds).toContain(`${HOST}/src:/workspace/src:ro`);
  });

  it('reviewer: every project mount read-only', () => {
    const binds = (opts('reviewer').HostConfig?.Binds ?? []).filter((b) =>
      b.includes('/workspace/'),
    );
    expect(binds.length).toBeGreaterThan(0);
    expect(binds.every((b) => b.endsWith(':ro'))).toBe(true);
  });

  it('passes the network mode and proxy env straight through', () => {
    const o = opts('engineer', 'orq-r1', ['HTTP_PROXY=http://proxy:8888']);
    expect(o.HostConfig?.NetworkMode).toBe('orq-r1');
    expect(o.Env).toContain('HTTP_PROXY=http://proxy:8888');
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
// LocalResultStore
// --------------------------------------------------------------------------------------

describe('LocalResultStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-store-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('prepare creates in/out dirs and host-path mount sources', async () => {
    const store = new LocalResultStore(root, '/host/.orchestrator-runs');
    const p = await store.prepare('run7');
    expect((await fs.stat(p.inDir)).isDirectory()).toBe(true);
    expect((await fs.stat(p.outDir)).isDirectory()).toBe(true);
    expect(p.mountSources).toEqual({
      inDir: '/host/.orchestrator-runs/run7/in',
      outDir: '/host/.orchestrator-runs/run7/out',
    });
  });

  it('finalize reads the summary the sub-agent wrote', async () => {
    const store = new LocalResultStore(root, '/host');
    const p = await store.prepare('run8');
    await fs.writeFile(path.join(p.outDir, 'status.json'), JSON.stringify({ summary: 'did the thing' }));
    const ctx: RunContext = {
      role: 'engineer',
      status: 'completed',
      exitCode: 0,
      startedAt: 'a',
      finishedAt: 'b',
    };
    const r = await store.finalize('run8', ctx);
    expect(r.summary).toBe('did the thing');
    expect(r.status).toBe('completed');
    expect(r.outputDir).toBe(p.outDir);
  });

  it('finalize downgrades a clean exit to "failed" when no status.json was produced', async () => {
    const store = new LocalResultStore(root, '/host');
    await store.prepare('run9');
    const r = await store.finalize('run9', {
      role: 'engineer',
      status: 'completed',
      exitCode: 0,
      startedAt: 'a',
      finishedAt: 'b',
    });
    expect(r.status).toBe('failed');
    expect(r.summary).toMatch(/no status\.json/);
  });

  it('cleanup removes the run directory', async () => {
    const store = new LocalResultStore(root, '/host');
    const p = await store.prepare('run10');
    await store.cleanup('run10');
    await expect(fs.stat(path.dirname(p.inDir))).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------------------
// spinUpAgent — lifecycle, with dockerode fully mocked
// --------------------------------------------------------------------------------------

class FakeStore implements ResultStore {
  prepared: string[] = [];
  finalized: RunContext[] = [];
  cleaned: string[] = [];
  constructor(private root: string) {}
  async prepare(runId: string): Promise<PreparedRun> {
    const inDir = path.join(this.root, runId, 'in');
    const outDir = path.join(this.root, runId, 'out');
    await fs.mkdir(inDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    this.prepared.push(runId);
    return {
      inDir,
      outDir,
      mountSources: { inDir: `/host/${runId}/in`, outDir: `/host/${runId}/out` },
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

function makeContainer(over: Partial<{ exitCode: number; wait: ReturnType<typeof vi.fn> }> = {}): FakeContainer {
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

describe('spinUpAgent', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-run-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('engineer: creates a per-run proxy + internal network, injects proxy env, tears them down', async () => {
    const { deps, docker, store, network, created, containers } = makeDeps(root);

    const result = await spinUpAgent({ role: 'engineer', task: { task: 'do X' } }, deps);

    expect(docker.createNetwork).toHaveBeenCalledOnce();
    const proxy = created.find((c) => c.name?.startsWith('orq-proxy-'));
    const agent = created.find((c) => c.name?.startsWith('orq-agent-'));
    expect(proxy).toBeTruthy();
    expect(agent).toBeTruthy();
    expect(network.connect).toHaveBeenCalledWith(
      expect.objectContaining({ EndpointConfig: { Aliases: ['proxy'] } }),
    );
    expect((agent!.opts as { Env: string[] }).Env).toContain('HTTP_PROXY=http://proxy:8888');
    expect((agent!.opts as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode).toMatch(
      /^orq-/,
    );

    // task written into the input dir
    const taskJson = JSON.parse(
      await fs.readFile(path.join(root, store.prepared[0]!, 'in', 'task.json'), 'utf8'),
    );
    expect(taskJson).toMatchObject({ role: 'engineer', task: 'do X' });

    // container was awaited and the run torn down (container + proxy + network)
    for (const c of containers) expect(c.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();

    // result came back through finalize; the store dir was NOT cleaned up
    expect(store.finalized).toHaveLength(1);
    expect(store.finalized[0]).toMatchObject({ role: 'engineer', status: 'completed', exitCode: 0 });
    expect(store.cleaned).toEqual([]);
    expect(result.status).toBe('completed');
  });

  it('reviewer: no network, no proxy, no proxy env', async () => {
    const { deps, docker, created } = makeDeps(root);
    await spinUpAgent({ role: 'reviewer', task: { task: 'review the diff' } }, deps);

    expect(docker.createNetwork).not.toHaveBeenCalled();
    expect(created.some((c) => c.name?.startsWith('orq-proxy-'))).toBe(false);
    const agent = created.find((c) => c.name?.startsWith('orq-agent-'))!;
    expect((agent.opts as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode).toBe('none');
    expect((agent.opts as { Env: string[] }).Env).toEqual([]);
  });

  it('a non-zero container exit yields status "failed"', async () => {
    const { deps, docker } = makeDeps(root);
    docker.createContainer.mockImplementation((o: { name?: string }) => {
      const c = makeContainer({ exitCode: o.name?.startsWith('orq-agent-') ? 3 : 0 });
      return Promise.resolve(c);
    });
    const result = await spinUpAgent({ role: 'engineer', task: { task: 'x' } }, deps);
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

    const result = await spinUpAgent({ role: 'reviewer', task: { task: 'x' }, timeoutMs: 20 }, deps);

    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(containers.some((c) => c.kill.mock.calls.length > 0)).toBe(true);
  });

  it('throws a build hint when the sandbox image is missing', async () => {
    const { deps, docker } = makeDeps(root);
    docker.getImage.mockReturnValue({ inspect: vi.fn().mockRejectedValue(new Error('404')) });
    await expect(spinUpAgent({ role: 'engineer', task: { task: 'x' } }, deps)).rejects.toThrow(
      /npm run sandbox:build/,
    );
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

    await expect(spinUpAgent({ role: 'engineer', task: { task: 'x' } }, deps)).rejects.toThrow('boom');
    for (const c of containers) expect(c.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();
  });
});
