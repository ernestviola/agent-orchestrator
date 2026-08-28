/**
 * The orchestrator loop.
 *
 * An LLM that plans conversationally with the user and delegates scoped tasks to
 * sub-agents through ONE tool — `spin_up_agent(role, task, context?)`. It never
 * issues container commands directly; what each role may touch is fixed by the
 * provisioning layer's code, not by this prompt (docs/DESIGN.md → "Approach").
 *
 * The human approval gate is enforced HERE, mechanically: after every completed
 * `test-engineer` run the deterministic `approveTests` callback is invoked, and an
 * `engineer` spin-up is refused until that approval is granted. The LLM cannot
 * satisfy the gate itself — the tool handler checks session state, it does not ask
 * the model to be well-behaved.
 *
 * Out of scope for now: the reviewer role (runtime not built), any git operations
 * (the human still runs those), and cost-tier model escalation.
 */
import type { ChatFn, ChatMessage, ChatTool, ToolCall } from './llm.js';
import type { AgentResult, Role, SpinUpParams } from './types.js';

/** Hard ceiling on tool round-trips within a single user turn (runaway guard). */
export const MAX_TOOL_ROUNDS = 16;

const DELEGABLE_ROLES: readonly Role[] = ['test-engineer', 'engineer', 'reviewer'];
const IMPLEMENTED_ROLES: readonly Role[] = ['test-engineer', 'engineer'];

export const SPIN_UP_AGENT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'spin_up_agent',
    description:
      'Provision an isolated container running one sub-agent for a single scoped ' +
      'task, wait for it to finish, and return its result (status, summary, iteration ' +
      'count, and a unified diff of its working copy). The container is torn down ' +
      'afterwards; nothing is committed. Roles: "test-engineer" writes tests/ with ' +
      'src/ read-only; "engineer" writes src/ and reads tests/ read-only (it runs ' +
      'them to verify but cannot modify one); "reviewer" is read-only (NOT YET ' +
      'IMPLEMENTED — do not use). An "engineer" ' +
      'call is refused until any test-engineer output produced this session has been ' +
      'approved by the human.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: [...DELEGABLE_ROLES],
          description: 'Which sub-agent role to run.',
        },
        task: {
          type: 'string',
          description: 'Natural-language description of the single task for the sub-agent.',
        },
        context: {
          type: 'string',
          description:
            'Optional supporting context: requirements, the approved test list, a diff ' +
            'to review, relevant file excerpts.',
        },
      },
      required: ['role', 'task'],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = [
  'You are the orchestrator of a multi-agent coding system. You do two things:',
  'reason out a build plan conversationally with the user, and delegate scoped',
  'tasks to role-based sub-agents by calling the spin_up_agent tool. Each sub-agent',
  'runs in its own disposable, isolated container. You do not write code or run',
  'commands yourself.',
  '',
  'Roles:',
  '- test-engineer: writes/updates files under tests/ to capture requirements as',
  '  executable tests. Sees src/ read-only. Its tests are EXPECTED to fail until an',
  '  engineer implements the code.',
  '- engineer: writes/updates files under src/ to make the tests pass. Reads tests/',
  '  read-only (it runs them to verify its work) but cannot modify a test.',
  '- reviewer: NOT YET IMPLEMENTED. Do not delegate to it.',
  '',
  'Human approval gate (non-negotiable): after a test-engineer run the system itself',
  'prompts the user to approve the drafted tests — you do not run that prompt. The',
  'spin_up_agent result for a test-engineer run reports the outcome as',
  '"humanApproved": true | false:',
  '  - true  -> the gate is satisfied and the tests are locked. Proceed to delegate',
  '            the implementation to the engineer in the same turn; do not ask the',
  '            user to approve again.',
  '  - false -> the user rejected the tests. Do not spin up the engineer (the system',
  '            will refuse it anyway). Discuss revisions and, if warranted, run the',
  '            test-engineer again.',
  'If you are implementing against tests the user wrote themselves (no test-engineer',
  'run this session), you may delegate to the engineer directly.',
  '',
  'Working style: keep the user informed of the plan before you act on it. Delegate',
  'one clear task at a time and report back what each sub-agent returned. Nothing is',
  'committed to git — that is the user\'s step. Be concise.',
].join('\n');

export interface OrchestratorDeps {
  /** The orchestrator LLM. Injected so it can be stubbed in tests. */
  chat: ChatFn;
  /** Provisions and runs one sub-agent. Wraps `spinUpAgent` in production. */
  spawn: (params: SpinUpParams) => Promise<AgentResult>;
  /**
   * The human approval gate. Called automatically after every COMPLETED
   * test-engineer run, with that run's result; returns whether the human approved
   * the drafted tests. Must be a real, deterministic prompt to the user.
   */
  approveTests: (result: AgentResult) => Promise<boolean>;
  /** Orchestrator-local path to the target project the sub-agents work on. */
  projectPath: string;
}

/** Read-only view of the gate state, for the CLI and tests. */
export interface GateState {
  testEngineerRuns: number;
  testsApproved: boolean;
}

export class OrchestratorSession {
  private readonly messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  private testEngineerRuns = 0;
  private testsApproved = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  get gate(): GateState {
    return { testEngineerRuns: this.testEngineerRuns, testsApproved: this.testsApproved };
  }

  /** Feed one user message and drive the model (through any tool calls) to a reply. */
  async send(userInput: string): Promise<string> {
    this.messages.push({ role: 'user', content: userInput });
    return this.drive();
  }

  private async drive(): Promise<string> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.deps.chat({ messages: this.messages, tools: [SPIN_UP_AGENT_TOOL] });

      if (res.toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: res.content });
        return res.content ?? '';
      }

      this.messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        const output = await this.dispatchTool(call);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    }

    const stalled = `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`;
    this.messages.push({ role: 'assistant', content: stalled });
    return stalled;
  }

  private async dispatchTool(call: ToolCall): Promise<string> {
    if (call.function.name !== 'spin_up_agent') {
      return err(`unknown tool: ${call.function.name}`);
    }

    let args: { role?: unknown; task?: unknown; context?: unknown };
    try {
      args = JSON.parse(call.function.arguments || '{}') as typeof args;
    } catch {
      return err('tool arguments were not valid JSON');
    }

    const role = args.role;
    if (typeof role !== 'string' || !DELEGABLE_ROLES.includes(role as Role)) {
      return err(`role must be one of ${DELEGABLE_ROLES.join(' | ')} (got ${JSON.stringify(role)})`);
    }
    if (!IMPLEMENTED_ROLES.includes(role as Role)) {
      return err(`the ${role} runtime is not implemented yet — do not delegate to it`);
    }
    if (typeof args.task !== 'string' || !args.task.trim()) {
      return err('task must be a non-empty string');
    }

    if (role === 'engineer' && this.testEngineerRuns > 0 && !this.testsApproved) {
      return err(
        'BLOCKED by the human approval gate: a test-engineer run this session has not ' +
          'been approved. The drafted tests must be reviewed and approved by the human ' +
          'before the engineer can be spun up. Ask the user to approve, or revise the ' +
          'tests with another test-engineer run.',
      );
    }

    let result: AgentResult;
    try {
      result = await this.deps.spawn({
        role: role as Role,
        task: {
          task: args.task,
          context: typeof args.context === 'string' ? args.context : undefined,
        },
        projectPath: this.deps.projectPath,
      });
    } catch (cause) {
      return err(`spin_up_agent failed: ${(cause as Error).message}`);
    }

    if (role === 'test-engineer') {
      this.testEngineerRuns += 1;
      this.testsApproved =
        result.status === 'completed' ? await this.deps.approveTests(result) : false;
    }

    return JSON.stringify({
      role: result.role,
      status: result.status,
      summary: result.summary,
      iterations: result.iterations ?? null,
      ...(role === 'test-engineer' ? { humanApproved: this.testsApproved } : {}),
      diff: truncate(result.diff, 6000),
      outputDir: result.outputDir,
    });
  }
}

function err(message: string): string {
  return JSON.stringify({ error: message });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n… [${s.length - n} more chars truncated]`;
}
