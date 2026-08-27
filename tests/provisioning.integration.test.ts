/**
 * INTEGRATION TEST — drives the real host Docker daemon.
 *
 * Prerequisites:
 *   npm run sandbox:build      # builds orq-sandbox:dev and orq-proxy:dev
 *   run from inside the orchestrator devcontainer (needs the /workspace bind mount
 *   and the mounted Docker socket)
 *
 * Run with:  npm run test:integration
 * It is excluded from the default `npm test` / pre-commit gate.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import Docker from 'dockerode';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalProvisioningDeps,
  reap,
  resolveProjectHostPath,
  spinUpAgent,
  tearDownAgent,
  type ProvisioningDeps,
} from '../src/provisioning.js';

const SANDBOX_IMAGE = 'orq-sandbox:dev';
const PROXY_IMAGE = 'orq-proxy:dev';

let deps: ProvisioningDeps;
let docker: Docker;
let hostProjectPath: string;
const runsToClean: string[] = [];

beforeAll(async () => {
  docker = new Docker();
  for (const image of [SANDBOX_IMAGE, PROXY_IMAGE]) {
    try {
      await docker.getImage(image).inspect();
    } catch {
      throw new Error(`image "${image}" missing — run \`npm run sandbox:build\` before this suite`);
    }
  }
  hostProjectPath = await resolveProjectHostPath(docker);
  deps = await createLocalProvisioningDeps({ docker });
});

afterEach(async () => {
  for (const runId of runsToClean.splice(0)) {
    await tearDownAgent(runId, deps).catch(() => undefined);
  }
});

afterAll(async () => {
  await reap(deps).catch(() => undefined);
});

async function labeledCount(): Promise<{ containers: number; networks: number }> {
  const containers = await docker.listContainers({ all: true, filters: { label: ['orq.run'] } });
  const networks = await docker.listNetworks({ filters: { label: ['orq.run'] } });
  return { containers: containers.length, networks: networks.length };
}

describe('spinUpAgent against real Docker', () => {
  it('reviewer: runs the stub, returns a result, and leaves nothing behind', async () => {
    const before = await labeledCount();
    const result = await spinUpAgent({ role: 'reviewer', task: { task: 'review the diff' } }, deps);

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatch(/reviewer/);
    runsToClean.push(result.runId);

    const log = await fs.readFile(path.join(result.outputDir, 'container.log'), 'utf8');
    expect(log).toMatch(/\bsrc\b/);
    expect(log).toMatch(/\btests\b/);

    // teardown in spinUpAgent already removed the container/proxy/network
    const after = await labeledCount();
    expect(after.containers).toBe(before.containers);
    expect(after.networks).toBe(before.networks);
  });

  it('engineer: tests/ is not mounted into the container', async () => {
    const result = await spinUpAgent({ role: 'engineer', task: { task: 'implement X' } }, deps);
    runsToClean.push(result.runId);
    expect(result.status).toBe('completed');

    const log = await fs.readFile(path.join(result.outputDir, 'container.log'), 'utf8');
    expect(log).toMatch(/\bsrc\b/);
    expect(log).not.toMatch(/\btests\b/);
  });
});

describe('mount + network boundaries (direct probes on the real images)', () => {
  it('a :ro bind mount rejects writes from inside the container', async () => {
    const c = await docker.createContainer({
      Image: SANDBOX_IMAGE,
      Entrypoint: ['sh', '-c', 'echo pwned > /workspace/src/PWNED_INTEGRATION'],
      User: 'agent',
      HostConfig: {
        Binds: [`${path.posix.join(hostProjectPath, 'src')}:/workspace/src:ro`],
        CapDrop: ['ALL'],
        NetworkMode: 'none',
        AutoRemove: false,
      },
    });
    try {
      await c.start();
      const { StatusCode } = await c.wait();
      expect(StatusCode).not.toBe(0);
    } finally {
      await c.remove({ force: true }).catch(() => undefined);
    }
    await expect(fs.stat(path.join(process.cwd(), 'src', 'PWNED_INTEGRATION'))).rejects.toThrow();
  });

  it('the egress proxy allows an allowlisted host and refuses everything else', async () => {
    const runId = `probe-${Date.now().toString(36)}`;
    const network = await docker.createNetwork({
      Name: `orq-${runId}`,
      Driver: 'bridge',
      Internal: true,
      Labels: { 'orq.run': runId },
    });
    const proxy = await docker.createContainer({
      Image: PROXY_IMAGE,
      name: `orq-proxy-${runId}`,
      Labels: { 'orq.run': runId, 'orq.role': 'proxy' },
      HostConfig: { NetworkMode: 'bridge', CapDrop: ['ALL'], AutoRemove: false },
    });

    async function probe(url: string): Promise<number> {
      const c = await docker.createContainer({
        Image: SANDBOX_IMAGE,
        Entrypoint: [
          'sh',
          '-c',
          `curl -sS -o /dev/null -m 20 -w '%{http_code}' ${url} || echo CURLFAIL`,
        ],
        User: 'agent',
        Env: ['HTTP_PROXY=http://proxy:8888', 'HTTPS_PROXY=http://proxy:8888'],
        HostConfig: { NetworkMode: `orq-${runId}`, CapDrop: ['ALL'], AutoRemove: false },
      });
      try {
        await c.start();
        await c.wait();
        const out = (
          (await c.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer
        ).toString('utf8');
        const m = out.match(/(\d{3}|CURLFAIL)/);
        return m ? (m[1] === 'CURLFAIL' ? -1 : Number(m[1])) : -1;
      } finally {
        await c.remove({ force: true }).catch(() => undefined);
      }
    }

    try {
      await proxy.start();
      await network.connect({ Container: proxy.id, EndpointConfig: { Aliases: ['proxy'] } });

      const allowed = await probe('https://api.github.com');
      const denied = await probe('https://example.com');

      expect(allowed).toBeGreaterThanOrEqual(200);
      expect(allowed).toBeLessThan(500);
      // tinyproxy answers a filtered CONNECT with 403, or curl fails the tunnel.
      expect(denied === 403 || denied === -1).toBe(true);
    } finally {
      await proxy.remove({ force: true }).catch(() => undefined);
      await network.remove().catch(() => undefined);
    }
  });
});
