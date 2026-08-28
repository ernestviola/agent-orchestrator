/**
 * Entry point. There is no orchestrator loop yet — this exposes the provisioning
 * layer directly for manual runs and maintenance.
 *
 *   npm run dev -- --reap
 *   npm run dev -- --engineer <projectPath> "<task text>"
 *   npm run dev -- --test-engineer <projectPath> "<task text>"
 */
import { createLocalProvisioningDeps, reap, spinUpAgent } from './provisioning.js';
import type { Role } from './types.js';

/** Roles with an in-container runtime that this CLI can drive directly. */
const RUNNABLE_ROLES = ['engineer', 'test-engineer'] as const satisfies readonly Role[];

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--reap')) {
    const deps = await createLocalProvisioningDeps();
    const { containers, networks } = await reap(deps);
    console.log(`reaped ${containers} container(s), ${networks} network(s)`);
    return;
  }

  for (const role of RUNNABLE_ROLES) {
    const i = argv.indexOf(`--${role}`);
    if (i === -1) continue;

    const projectPath = argv[i + 1];
    const task = argv[i + 2];
    if (!projectPath || !task) {
      throw new Error(`usage: --${role} <projectPath> "<task text>"`);
    }
    const deps = await createLocalProvisioningDeps();
    const result = await spinUpAgent({ role, task: { task }, projectPath }, deps);
    console.log(`\nrole:       ${result.role}`);
    console.log(`status:     ${result.status}`);
    console.log(`iterations: ${result.iterations ?? '-'}`);
    console.log(`summary:    ${result.summary}`);
    console.log(`artifacts:  ${result.outputDir}`);
    console.log(result.diff ? `\n${result.diff}` : '\n(no changes)');
    if (result.status !== 'completed') process.exitCode = 1;
    return;
  }

  console.log(
    'agent-orchestrator: provisioning layer ready. ' +
      'Try: --reap | --engineer <path> "<task>" | --test-engineer <path> "<task>"',
  );
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
