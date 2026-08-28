/**
 * Model routing. Per-task, per-role model selection (docs/DESIGN.md → "Model routing").
 *
 * v1 is deliberately minimal: one model for every role, routed via OpenRouter's
 * OpenAI-compatible API. Cost-tier escalation (start cheap, escalate on failure) is a
 * documented follow-on and is not implemented here.
 */
import type { Role } from './types.js';

export interface ModelRoute {
  /** OpenRouter model id, e.g. `"anthropic/claude-haiku-4.5"`. */
  model: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  /** Name of the env var holding the API key (the value is injected into the
   *  sub-agent container by the provisioning layer, never read here). */
  apiKeyEnv: string;
}

export const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const API_KEY_ENV = 'OPENROUTER_API_KEY';

/**
 * @param role      the sub-agent role (unused for now — one model fits all in v1).
 * @param override  explicit model id from the caller (`SpinUpParams.model`); wins over
 *                  the `ORQ_MODEL` env default.
 */
export function selectModel(role: Role, override?: string): ModelRoute {
  void role;
  return {
    model: override ?? process.env.ORQ_MODEL ?? DEFAULT_MODEL,
    baseUrl: process.env.ORQ_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
    apiKeyEnv: API_KEY_ENV,
  };
}
