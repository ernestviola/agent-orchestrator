import { describe, expect, it, vi } from 'vitest';

import type { ChatFn, ChatMessage, ChatResult, ToolCall } from '../src/llm.js';
import {
  MAX_TOOL_ROUNDS,
  OrchestratorSession,
  SPIN_UP_AGENT_TOOL,
  type OrchestratorDeps,
} from '../src/orchestrator.js';
import type { AgentResult, SpinUpParams } from '../src/types.js';

// --------------------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------------------

function toolTurn(...calls: ToolCall[]): ChatResult {
  return { content: null, toolCalls: calls, finishReason: 'tool_calls' };
}
function textTurn(text: string): ChatResult {
  return { content: text, toolCalls: [], finishReason: 'stop' };
}
function spinUpCall(
  args: { role?: unknown; task?: unknown; context?: unknown },
  id = `tc-${Math.random().toString(36).slice(2, 7)}`,
): ToolCall {
  return { id, type: 'function', function: { name: 'spin_up_agent', arguments: JSON.stringify(args) } };
}

/** A `chat` that replays a fixed script; the last entry repeats if over-consumed. */
function scriptedChat(script: ChatResult[]): { fn: ChatFn; calls: { messages: ChatMessage[] }[] } {
  const calls: { messages: ChatMessage[] }[] = [];
  let i = 0;
  const fn: ChatFn = async ({ messages }) => {
    calls.push({ messages: structuredClone(messages) });
    const r = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return r;
  };
  return { fn, calls };
}

function agentResult(over: Partial<AgentResult> = {}): AgentResult {
  return {
    runId: 'run-1',
    role: 'test-engineer',
    status: 'completed',
    exitCode: 0,
    summary: 'drafted 2 tests',
    diff: '--- a/tests/x.mjs\n+++ b/tests/x.mjs\n+assert(true)',
    iterations: 1,
    outputDir: '/runs/run-1/out',
    startedAt: 't0',
    finishedAt: 't1',
    ...over,
  };
}

function makeDeps(over: Partial<OrchestratorDeps> = {}) {
  const spawnCalls: SpinUpParams[] = [];
  const spawn = vi.fn(async (p: SpinUpParams): Promise<AgentResult> => {
    spawnCalls.push(p);
    return agentResult({ role: p.role, summary: `${p.role} ran` });
  });
  const approveTests = vi.fn(async (_r: AgentResult) => true);
  const deps: OrchestratorDeps = {
    chat: scriptedChat([textTurn('hello')]).fn,
    projectPath: '/target',
    ...over,
    // spies win unless the caller explicitly overrode them
    spawn: over.spawn ?? spawn,
    approveTests: over.approveTests ?? approveTests,
  };
  return { deps, spawn, spawnCalls, approveTests };
}

// --------------------------------------------------------------------------------------
// tool schema
// --------------------------------------------------------------------------------------

describe('SPIN_UP_AGENT_TOOL', () => {
  it('is a single function tool named spin_up_agent with role + task required', () => {
    expect(SPIN_UP_AGENT_TOOL.type).toBe('function');
    expect(SPIN_UP_AGENT_TOOL.function.name).toBe('spin_up_agent');
    expect(SPIN_UP_AGENT_TOOL.function.parameters.required).toEqual(['role', 'task']);
    const props = SPIN_UP_AGENT_TOOL.function.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.role?.enum).toEqual(['test-engineer', 'engineer', 'reviewer']);
  });
});

// --------------------------------------------------------------------------------------
// plain conversation
// --------------------------------------------------------------------------------------

describe('OrchestratorSession — conversation', () => {
  it('returns the model text when no tool is called and never spawns', async () => {
    const { deps, spawn } = makeDeps({ chat: scriptedChat([textTurn('here is the plan')]).fn });
    const session = new OrchestratorSession(deps);
    await expect(session.send('what should we do?')).resolves.toBe('here is the plan');
    expect(spawn).not.toHaveBeenCalled();
    expect(session.gate).toEqual({ testEngineerRuns: 0, testsApproved: false });
  });

  it('stops with a notice after MAX_TOOL_ROUNDS if the model never finishes', async () => {
    // Always asks for another engineer run (allowed: no test-engineer run happened).
    const { deps, spawn } = makeDeps({
      chat: scriptedChat([toolTurn(spinUpCall({ role: 'engineer', task: 'loop forever' }))]).fn,
    });
    const session = new OrchestratorSession(deps);
    const reply = await session.send('go');
    expect(reply).toMatch(new RegExp(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds`));
    expect(spawn).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
  });
});

// --------------------------------------------------------------------------------------
// delegation + tool-result plumbing
// --------------------------------------------------------------------------------------

describe('OrchestratorSession — delegation', () => {
  it('runs a spin_up_agent call, feeds the result back, and returns the final text', async () => {
    const { fn, calls } = scriptedChat([
      toolTurn(spinUpCall({ role: 'engineer', task: 'implement fizzbuzz' }, 'call-1')),
      textTurn('engineer done'),
    ]);
    const { deps, spawnCalls } = makeDeps({ chat: fn });
    const session = new OrchestratorSession(deps);

    await expect(session.send('build it')).resolves.toBe('engineer done');

    expect(spawnCalls).toEqual([
      { role: 'engineer', task: { task: 'implement fizzbuzz', context: undefined }, projectPath: '/target' },
    ]);
    // second model call must include the tool result
    const toolMsg = calls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('call-1');
    expect(JSON.parse(toolMsg!.content as string)).toMatchObject({ role: 'engineer', status: 'completed' });
  });

  it('passes context through to the sub-agent task', async () => {
    const { deps, spawnCalls } = makeDeps({
      chat: scriptedChat([
        toolTurn(spinUpCall({ role: 'engineer', task: 't', context: 'the approved tests: ...' })),
        textTurn('ok'),
      ]).fn,
    });
    await new OrchestratorSession(deps).send('go');
    expect(spawnCalls[0]!.task.context).toBe('the approved tests: ...');
  });

  it('rejects an unimplemented reviewer delegation without spawning', async () => {
    const { fn, calls } = scriptedChat([
      toolTurn(spinUpCall({ role: 'reviewer', task: 'review the diff' })),
      textTurn('acknowledged'),
    ]);
    const { deps, spawn } = makeDeps({ chat: fn });
    await new OrchestratorSession(deps).send('review');
    expect(spawn).not.toHaveBeenCalled();
    const toolMsg = calls[1]!.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content as string).error).toMatch(/reviewer runtime is not implemented/);
  });

  it('returns an error tool-result for an unknown tool name and does not spawn', async () => {
    const badCall: ToolCall = { id: 'x', type: 'function', function: { name: 'rm_rf', arguments: '{}' } };
    const { fn, calls } = scriptedChat([toolTurn(badCall), textTurn('noted')]);
    const { deps, spawn } = makeDeps({ chat: fn });
    await new OrchestratorSession(deps).send('go');
    expect(spawn).not.toHaveBeenCalled();
    const toolMsg = calls[1]!.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content as string).error).toMatch(/unknown tool/);
  });

  it('returns an error tool-result when the tool arguments are not valid JSON', async () => {
    const badCall: ToolCall = {
      id: 'x',
      type: 'function',
      function: { name: 'spin_up_agent', arguments: '{not json' },
    };
    const { fn, calls } = scriptedChat([toolTurn(badCall), textTurn('noted')]);
    const { deps, spawn } = makeDeps({ chat: fn });
    await new OrchestratorSession(deps).send('go');
    expect(spawn).not.toHaveBeenCalled();
    const toolMsg = calls[1]!.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content as string).error).toMatch(/not valid JSON/);
  });

  it('rejects a spin_up_agent call with an empty task', async () => {
    const { fn, calls } = scriptedChat([
      toolTurn(spinUpCall({ role: 'engineer', task: '   ' })),
      textTurn('noted'),
    ]);
    const { deps, spawn } = makeDeps({ chat: fn });
    await new OrchestratorSession(deps).send('go');
    expect(spawn).not.toHaveBeenCalled();
    const toolMsg = calls[1]!.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content as string).error).toMatch(/task must be a non-empty string/);
  });
});

// --------------------------------------------------------------------------------------
// the human approval gate
// --------------------------------------------------------------------------------------

describe('OrchestratorSession — human approval gate', () => {
  it('runs approveTests after a completed test-engineer run and reports the verdict to the model', async () => {
    const { fn, calls } = scriptedChat([
      toolTurn(spinUpCall({ role: 'test-engineer', task: 'draft tests' }, 'te-1')),
      textTurn('tests drafted'),
    ]);
    const approveTests = vi.fn(async (_r: AgentResult) => true);
    const { deps } = makeDeps({ chat: fn, approveTests });
    const session = new OrchestratorSession(deps);

    await session.send('write tests');

    expect(approveTests).toHaveBeenCalledOnce();
    expect(approveTests.mock.calls[0]![0]).toMatchObject({ role: 'test-engineer', status: 'completed' });
    expect(session.gate).toEqual({ testEngineerRuns: 1, testsApproved: true });
    const toolMsg = calls[1]!.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content as string).humanApproved).toBe(true);
  });

  it('does not call approveTests when the test-engineer run did not complete', async () => {
    const spawn = vi.fn(async (p: SpinUpParams) => agentResult({ role: p.role, status: 'failed' }));
    const approveTests = vi.fn(async (_r: AgentResult) => true);
    const deps = {
      chat: scriptedChat([
        toolTurn(spinUpCall({ role: 'test-engineer', task: 'draft' })),
        textTurn('failed'),
      ]).fn,
      spawn,
      approveTests,
      projectPath: '/target',
    };
    const session = new OrchestratorSession(deps);
    await session.send('go');
    expect(approveTests).not.toHaveBeenCalled();
    expect(session.gate).toEqual({ testEngineerRuns: 1, testsApproved: false });
  });

  it('BLOCKS an engineer spin-up while an unapproved test-engineer run exists', async () => {
    const { fn, calls } = scriptedChat([
      toolTurn(spinUpCall({ role: 'test-engineer', task: 'draft tests' }, 'te-1')),
      toolTurn(spinUpCall({ role: 'engineer', task: 'implement' }, 'eng-1')),
      textTurn('had to stop'),
    ]);
    const { deps, spawn } = makeDeps({ chat: fn, approveTests: vi.fn(async (_r: AgentResult) => false) });
    const session = new OrchestratorSession(deps);

    await session.send('build the feature');

    // test-engineer ran; engineer did NOT
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0].role).toBe('test-engineer');
    const engineerToolMsg = calls[2]!.messages.filter((m) => m.role === 'tool').at(-1);
    expect(JSON.parse(engineerToolMsg!.content as string).error).toMatch(/BLOCKED by the human approval gate/);
  });

  it('allows the engineer spin-up once the tests are approved', async () => {
    const { deps, spawn } = makeDeps({
      chat: scriptedChat([
        toolTurn(spinUpCall({ role: 'test-engineer', task: 'draft tests' })),
        toolTurn(spinUpCall({ role: 'engineer', task: 'implement' })),
        textTurn('shipped'),
      ]).fn,
      approveTests: vi.fn(async (_r: AgentResult) => true),
    });
    const session = new OrchestratorSession(deps);

    await expect(session.send('build it')).resolves.toBe('shipped');
    expect(spawn.mock.calls.map((c) => c[0].role)).toEqual(['test-engineer', 'engineer']);
  });

  it('allows an engineer spin-up with no prior test-engineer run (implementing against human tests)', async () => {
    const { deps, spawn } = makeDeps({
      chat: scriptedChat([
        toolTurn(spinUpCall({ role: 'engineer', task: 'implement against existing tests' })),
        textTurn('done'),
      ]).fn,
    });
    await new OrchestratorSession(deps).send('go');
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]![0].role).toBe('engineer');
  });

  it('re-locks after a fresh unapproved test-engineer run, re-blocking the engineer', async () => {
    let verdict = true;
    const approveTests = vi.fn(async (_r: AgentResult) => verdict);
    const { fn, calls } = scriptedChat([
      toolTurn(spinUpCall({ role: 'test-engineer', task: 'v1' })),
      toolTurn(spinUpCall({ role: 'engineer', task: 'impl v1' }, 'eng-ok')),
      toolTurn(spinUpCall({ role: 'test-engineer', task: 'v2' })),
      toolTurn(spinUpCall({ role: 'engineer', task: 'impl v2' }, 'eng-blocked')),
      textTurn('stopped'),
    ]);
    const spawn = vi.fn(async (p: SpinUpParams) => {
      if (p.role === 'test-engineer' && p.task.task === 'v2') verdict = false;
      return agentResult({ role: p.role });
    });
    const session = new OrchestratorSession({ chat: fn, spawn, approveTests, projectPath: '/t' });

    await session.send('iterate');

    // te(v1) ok -> eng(impl v1) ran; te(v2) rejected -> eng(impl v2) blocked
    expect(spawn.mock.calls.map((c) => c[0].role)).toEqual(['test-engineer', 'engineer', 'test-engineer']);
    const lastTool = calls[4]!.messages.filter((m) => m.role === 'tool').at(-1);
    expect(JSON.parse(lastTool!.content as string).error).toMatch(/BLOCKED/);
    expect(session.gate).toEqual({ testEngineerRuns: 2, testsApproved: false });
  });
});
