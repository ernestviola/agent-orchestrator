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
 * Model for the orchestrator LLM itself (the planning + delegation loop that runs in
 * this trusted-tier container, not a sub-agent). The design doc wants a stronger
 * model here than for a well-scoped sub-agent task; kept at the shared default for
 * now and overridable via `ORQ_ORCHESTRATOR_MODEL`. Cost-tiering is a follow-on.
 */
export const ORCHESTRATOR_MODEL = 'anthropic/claude-haiku-4.5';

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

/**
 * Route for the orchestrator LLM. Unlike sub-agent routes, this credential is read
 * and used in-process (the orchestrator runs in the trusted tier with direct egress)
 * — it is a *model* credential, still never logged or committed.
 *
 * @param override  explicit model id; wins over the `ORQ_ORCHESTRATOR_MODEL` env default.
 */
export function selectOrchestratorModel(override?: string): ModelRoute {
  return {
    model: override ?? process.env.ORQ_ORCHESTRATOR_MODEL ?? ORCHESTRATOR_MODEL,
    baseUrl: process.env.ORQ_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
    apiKeyEnv: API_KEY_ENV,
  };
}
