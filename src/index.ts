/**
 * Entry point. Phase 1 has no orchestrator loop yet — this just exposes the
 * provisioning layer's maintenance helper so orphaned sub-agent containers/networks
 * from a crashed run can be swept.
 *
 *   npm run dev -- --reap
 */
import { createLocalProvisioningDeps, reap } from './provisioning.js';

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--reap')) {
    const deps = await createLocalProvisioningDeps();
    const { containers, networks } = await reap(deps);
    console.log(`reaped ${containers} container(s), ${networks} network(s)`);
    return;
  }
  console.log('agent-orchestrator: provisioning layer ready (Phase 1). Try: --reap');
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
