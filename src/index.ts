/**
 * Entry point.
 *
 *   npm run dev -- --reap
 *   npm run dev -- --engineer      <projectPath> "<task text>"
 *   npm run dev -- --test-engineer <projectPath> "<task text>"
 *   npm run dev -- --orchestrate   [projectPath]        # conversational REPL
 *
 * The `--engineer` / `--test-engineer` flags drive one sub-agent directly (no
 * planning, no approval gate) — handy for development. `--orchestrate` starts the
 * real loop: an LLM that plans with you and delegates via `spin_up_agent`.
 */
import * as readline from 'node:readline/promises';

import { createOpenRouterChat } from './llm.js';
import { selectOrchestratorModel } from './models.js';
import { OrchestratorSession } from './orchestrator.js';
import { createLocalProvisioningDeps, reap, spinUpAgent } from './provisioning.js';
import type { AgentResult, Role, SpinUpParams } from './types.js';

/** Roles with an in-container runtime that this CLI can drive directly. */
const RUNNABLE_ROLES = ['engineer', 'test-engineer'] as const satisfies readonly Role[];

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--reap')) {
    const deps = await createLocalProvisioningDeps();
    const { containers, networks } = await reap(deps);
    console.log(`reaped ${containers} container(s), ${networks} network(s)`);
    return;
  }

  const oi = argv.indexOf('--orchestrate');
  if (oi !== -1) {
    const next = argv[oi + 1];
    const projectPath = next && !next.startsWith('--') ? next : process.cwd();
    await runOrchestratorRepl(projectPath);
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
    'agent-orchestrator. Try:\n' +
      '  --orchestrate [path]              conversational planning + delegation loop\n' +
      '  --engineer      <path> "<task>"   run one engineer sub-agent directly\n' +
      '  --test-engineer <path> "<task>"   run one test-engineer sub-agent directly\n' +
      '  --reap                           clean up orphaned containers / networks',
  );
}

async function runOrchestratorRepl(projectPath: string): Promise<void> {
  const route = selectOrchestratorModel();
  const apiKey = process.env[route.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${route.apiKeyEnv} is not set — the orchestrator needs it to reach the model. ` +
        'Add it to .env.local.',
    );
  }

  const chat = createOpenRouterChat({ model: route.model, baseUrl: route.baseUrl, apiKey });
  const provisioning = await createLocalProvisioningDeps();
  const spawn = (params: SpinUpParams): Promise<AgentResult> => spinUpAgent(params, provisioning);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => rl.close());

  const approveTests = async (result: AgentResult): Promise<boolean> => {
    console.log('\n─────────────── HUMAN APPROVAL GATE ───────────────');
    console.log(`test-engineer run ${result.runId} — ${result.status}`);
    console.log(`summary: ${result.summary}`);
    console.log(`\n${result.diff || '(no diff produced)'}`);
    console.log('───────────────────────────────────────────────────');
    let answer: string;
    try {
      answer = await rl.question('Approve these drafted tests for the engineer? [y/N] ');
    } catch {
      console.log('input closed — treating as NOT approved.');
      return false;
    }
    const approved = /^y(es)?$/i.test(answer.trim());
    console.log(approved ? 'approved — tests locked.' : 'not approved.');
    return approved;
  };

  const session = new OrchestratorSession({ chat, spawn, approveTests, projectPath });

  console.log(`orchestrator ready (model: ${route.model}, target: ${projectPath}).`);
  console.log('Describe what you want built. Ctrl-D or "exit" to quit.');

  for (;;) {
    let line: string;
    try {
      line = await rl.question('\n> ');
    } catch {
      break; // interface closed (Ctrl-D / Ctrl-C / end of piped input)
    }
    const trimmed = line.trim();
    if (trimmed === 'exit' || trimmed === 'quit') break;
    if (!trimmed) continue;
    try {
      const reply = await session.send(line);
      console.log(`\n${reply}`);
    } catch (err) {
      console.error(`\nerror: ${(err as Error).message}`);
    }
  }
  rl.close();
  console.log('\nbye');
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
