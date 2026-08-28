/**
 * Minimal OpenAI-compatible chat client for the ORCHESTRATOR (trusted tier).
 *
 * The sub-agent runtime has its own inline client in `sandbox/agent/agent.mjs` and
 * routes through the per-run egress proxy; this one runs in the orchestrator
 * container, which has direct egress (docs/DESIGN.md → two-tier model), so it uses
 * the global `fetch` with no proxy agent.
 *
 * Only the slice of the chat-completions API the orchestrator loop needs: a single
 * turn, optional tool definitions, and tool-call parsing. No streaming.
 */

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema for the tool's arguments. */
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** `null` on an assistant turn that only made tool calls. */
  content: string | null;
  /** Present on assistant turns that called tools. */
  tool_calls?: ToolCall[];
  /** Required on `role: 'tool'` messages — echoes the `ToolCall.id` being answered. */
  tool_call_id?: string;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
}

/** Injected into the orchestrator so tests can stub the model. */
export type ChatFn = (args: { messages: ChatMessage[]; tools?: ChatTool[] }) => Promise<ChatResult>;

export interface OpenRouterChatConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Test seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createOpenRouterChat(cfg: OpenRouterChatConfig): ChatFn {
  const doFetch = cfg.fetchImpl ?? fetch;
  return async ({ messages, tools }) => {
    const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        'x-title': 'agent-orchestrator',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`orchestrator model API ${res.status}: ${text.slice(0, 500)}`);
    }
    let data: {
      choices?: {
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }[];
    };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`orchestrator model returned non-JSON: ${text.slice(0, 200)}`);
    }
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error('orchestrator model returned no message');
    return {
      content: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? 'stop',
    };
  };
}
