# agent-orchestrator

Multi-agent orchestrator CLI. An orchestrator LLM reasons out a build plan with the user and
delegates scoped coding tasks to role-based sub-agents (`test-engineer`, `engineer`,
`reviewer`), each provisioned as its own isolated, disposable Docker container.

Full architecture and rationale: [`docs/DESIGN.md`](docs/DESIGN.md). Current status and
decision log: [`docs/CONTEXT.md`](docs/CONTEXT.md).

## Two-tier container security model

This repo is the **trusted tier** — the orchestrator/provisioning layer. It runs human-written
infrastructure code (not LLM-generated actions), so it runs in a lighter devcontainer with the
Docker socket mounted, which it uses to create and tear down sub-agent containers.

The **sub-agent containers** it provisions are the hardened tier: `--cap-drop=ALL`, non-root
user, read-only root filesystem, egress only through an allowlist proxy, role-scoped
read-only / read-write mounts, and **never** any git credential. See `docs/DESIGN.md` →
"Two-tier container security model" and "Git credentials and result handoff".

## Layout

| Path | What |
|---|---|
| `src/types.ts` | Shared types + the sub-agent result-handoff contract (`ResultStore`, `AgentResult`) |
| `src/roles.ts` | Role mount/permission profiles — the security boundary between sub-agent roles |
| `src/provisioning.ts` | `spinUpAgent` / `tearDownAgent` — dockerode-based container lifecycle + per-run working-copy staging |
| `src/orchestrator.ts` | The orchestrator loop — LLM tool-use over `spin_up_agent`, with the human approval gate enforced in the tool handler |
| `src/llm.ts` | OpenAI-compatible chat client for the orchestrator (trusted tier, direct egress) |
| `src/models.ts` | Per-task model routing (OpenRouter, OpenAI-compatible) |
| `sandbox/` | Sub-agent container assets (image, egress proxy, in-container agent runtime). Ported from [`ai-dev-template`](https://github.com/ernestviola/ai-dev-template); see `sandbox/README.md` |
| `fixtures/sample-project/` | Dependency-free target project (failing tests) for the engineer / test-engineer slices |
| `tests/` | Unit + integration tests, mirroring `src/` |

## Development

```sh
npm install
npm run build              # tsc — compiles src/ to dist/ (strict)
npm run typecheck          # strict type-check of src/ + tests/ (no emit)
npm test                   # unit tests (tests/*.test.ts) — dockerode mocked, no real containers
npm run sandbox:build      # build the sub-agent + proxy images (orq-sandbox:dev, orq-proxy:dev)
npm run test:integration   # integration tests (tests/*.integration.test.ts) — real Docker; run sandbox:build first
```

Requires `OPENROUTER_API_KEY` in `.env.local` (a *model* credential — not the git-credential
boundary). Optionally set `ORQ_MODEL` (sub-agents, default `anthropic/claude-haiku-4.5`) and
`ORQ_ORCHESTRATOR_MODEL` (orchestrator LLM, same default).

### The orchestrator loop

```sh
npm run sandbox:build
npm run dev -- --orchestrate fixtures/sample-project
```

Starts a REPL: describe what you want built, and an LLM plans with you and delegates to
sub-agents via a single `spin_up_agent(role, task)` tool. After any `test-engineer` run the
CLI shows you the drafted tests and asks for approval; an `engineer` spin-up is **mechanically
refused** until that approval is given (enforced in the tool handler, not the prompt). Nothing
is committed — that's your step. Only dependency-free target projects work for now (see
`docs/CONTEXT.md` → self-hosting §2).

### Run one sub-agent directly (no planning, no gate)

```sh
npm run dev -- --engineer      fixtures/sample-project "Implement fizzbuzz so the tests pass"
npm run dev -- --test-engineer fixtures/sample-project "Add tests asserting fizzbuzz coerces its output to a string"
```

A hardened container is provisioned and a model edits a *working copy* of the project:
`--engineer` edits `src/` and loops until `node --test` passes; `--test-engineer` edits
`tests/` once (its drafted tests are expected to fail until an engineer implements the code).
The printed result includes a diff; the real `fixtures/sample-project/` on disk is never modified.

## Status

The provisioning layer, the **engineer** + **test-engineer** slices, and the **orchestrator
loop + human approval gate** work end to end with a real model. No **reviewer** runtime yet,
and the orchestrator can only target dependency-free projects until writable-deps sandbox
support lands — see `docs/CONTEXT.md`.
