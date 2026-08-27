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
| `src/models.ts` | Per-task model routing (OpenRouter, OpenAI-compatible) |
| `sandbox/` | Sub-agent container assets (image, egress proxy, in-container agent runtime). Ported from [`ai-dev-template`](https://github.com/ernestviola/ai-dev-template); see `sandbox/README.md` |
| `fixtures/sample-project/` | Dependency-free target project (failing tests) for the engineer slice |
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

### Run one engineer task against a real model

Requires `OPENROUTER_API_KEY` in `.env.local` (a *model* credential — not the git-credential
boundary). Optionally set `ORQ_MODEL` (default `anthropic/claude-3.5-haiku`).

```sh
npm run sandbox:build
npm run dev -- --engineer fixtures/sample-project "Implement fizzbuzz so the tests pass"
```

A hardened container is provisioned, a model edits a *working copy* of the project's `src/`
until `node --test` passes, and the printed result includes a diff. The real
`fixtures/sample-project/` on disk is never modified.

## Status

The provisioning layer and the first vertical slice (one **engineer** task, end to end, with a
real model) work. No orchestrator LLM / planning loop, no test-engineer or reviewer runtimes,
no human approval gate yet — see `docs/CONTEXT.md`.
