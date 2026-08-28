/**
 * INTEGRATION TEST — drives the real host Docker daemon.
 *
 * Prerequisites:
 *   npm run sandbox:build      # builds orq-sandbox:dev and orq-proxy:dev
 *   run from inside the orchestrator devcontainer (needs the /workspace bind mount
 *   and the mounted Docker socket)
 *   the end-to-end engineer test also needs OPENROUTER_API_KEY in the environment
 *   (via .env.local); it is skipped when that is absent.
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
const SAMPLE_PROJECT = path.join(process.cwd(), 'fixtures', 'sample-project');
const NODE_RUNTIME_PROJECT = path.join(process.cwd(), 'fixtures', 'node-runtime-project');
const HAVE_KEY = !!process.env.OPENROUTER_API_KEY;

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
  await fs.rm(path.join(process.cwd(), '.orchestrator-runs'), { recursive: true, force: true }).catch(
    () => undefined,
  );
});

async function labeledCount(): Promise<{ containers: number; networks: number }> {
  const containers = await docker.listContainers({ all: true, filters: { label: ['orq.run'] } });
  const networks = await docker.listNetworks({ filters: { label: ['orq.run'] } });
  return { containers: containers.length, networks: networks.length };
}

describe('spinUpAgent against real Docker', () => {
  it('fails fast (no Docker resources created) when OPENROUTER_API_KEY is missing', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const before = await labeledCount();
    try {
      await expect(
        spinUpAgent(
          { role: 'engineer', task: { task: 'implement fizzbuzz' }, projectPath: SAMPLE_PROJECT },
          deps,
        ),
      ).rejects.toThrow(/OPENROUTER_API_KEY is not set/);
      const after = await labeledCount();
      expect(after).toEqual(before);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it.skipIf(!HAVE_KEY)(
    'engineer: a real model makes the sample project pass, returns a diff, leaves the target untouched',
    async () => {
      const before = await labeledCount();
      const original = await fs.readFile(path.join(SAMPLE_PROJECT, 'src', 'fizzbuzz.mjs'), 'utf8');

      const result = await spinUpAgent(
        {
          role: 'engineer',
          task: {
            task: 'Implement fizzbuzz(n) in src/fizzbuzz.mjs so that every test in tests/ passes.',
          },
          projectPath: SAMPLE_PROJECT,
        },
        deps,
      );
      runsToClean.push(result.runId);

      expect(result.status).toBe('completed');
      expect(result.iterations).toBeGreaterThanOrEqual(1);
      expect(result.diff).toMatch(/fizzbuzz\.mjs/);
      expect(result.diff).toMatch(/^\+.*Fizz/m);

      // artifacts retrieved via the ResultStore contract
      const status = JSON.parse(
        await fs.readFile(path.join(result.outputDir, 'status.json'), 'utf8'),
      );
      expect(status.status).toBe('completed');
      expect(await fs.readFile(path.join(result.outputDir, 'agent.log'), 'utf8')).toMatch(/iteration/);

      // the real target project on disk was never modified — only the working copy
      expect(await fs.readFile(path.join(SAMPLE_PROJECT, 'src', 'fizzbuzz.mjs'), 'utf8')).toBe(
        original,
      );

      const after = await labeledCount();
      expect(after.containers).toBe(before.containers);
      expect(after.networks).toBe(before.networks);
    },
    180_000,
  );

  it.skipIf(!HAVE_KEY)(
    'test-engineer: a real model drafts a test file under tests/, returns a diff, leaves the target untouched',
    async () => {
      const before = await labeledCount();
      const testsDir = path.join(SAMPLE_PROJECT, 'tests');
      const originalStub = await fs.readFile(path.join(SAMPLE_PROJECT, 'src', 'fizzbuzz.mjs'), 'utf8');
      const originalTests = (await fs.readdir(testsDir)).sort();

      const result = await spinUpAgent(
        {
          role: 'test-engineer',
          task: {
            task:
              'Add a new test file under tests/ that asserts fizzbuzz(n) coerces its result to a ' +
              'string: fizzbuzz(1) is the string "1" (not the number 1), and typeof fizzbuzz(1) ' +
              'is "string". Do not modify the existing test file.',
          },
          projectPath: SAMPLE_PROJECT,
        },
        deps,
      );
      runsToClean.push(result.runId);

      expect(result.status).toBe('completed');
      // a file under tests/ was added or changed in the working copy
      expect(result.diff).toMatch(/^\+\+\+ b\/.*tests\//m);
      expect(result.diff.length).toBeGreaterThan(0);

      const status = JSON.parse(
        await fs.readFile(path.join(result.outputDir, 'status.json'), 'utf8'),
      );
      expect(status.role).toBe('test-engineer');
      expect(Array.isArray(status.filesWritten) && status.filesWritten.length).toBeGreaterThanOrEqual(
        1,
      );
      expect(await fs.readFile(path.join(result.outputDir, 'agent.log'), 'utf8')).toMatch(/iteration/);

      // the real target project on disk was never touched — only the working copy
      expect((await fs.readdir(testsDir)).sort()).toEqual(originalTests);
      expect(await fs.readFile(path.join(SAMPLE_PROJECT, 'src', 'fizzbuzz.mjs'), 'utf8')).toBe(
        originalStub,
      );

      const after = await labeledCount();
      expect(after.containers).toBe(before.containers);
      expect(after.networks).toBe(before.networks);
    },
    180_000,
  );

  it.skipIf(!HAVE_KEY)(
    'engineer: a target with sandboxReadonlyPaths + sandboxWritablePaths runs its testCmd and completes',
    async () => {
      const result = await spinUpAgent(
        {
          role: 'engineer',
          task: {
            task: 'Add a JSDoc comment above the greet function in src/greet.mjs. Keep every test passing.',
          },
          projectPath: NODE_RUNTIME_PROJECT,
        },
        deps,
      );
      runsToClean.push(result.runId);

      expect(result.status).toBe('completed');
      // the sub-agent actually ran the target's test command (not a vacuous no-test pass)
      const log = await fs.readFile(path.join(result.outputDir, 'agent.log'), 'utf8');
      expect(log).toMatch(/tests exit=0 pass=true/);
      expect(result.diff).toMatch(/greet\.mjs/);
    },
    180_000,
  );
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
