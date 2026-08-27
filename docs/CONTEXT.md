## Current Task

Phase 1 (container provisioning layer) is implemented and verified — see "Recently Completed". Next up: wire a real agent runtime into `sandbox/agent-entrypoint.sh` (currently a stub) and begin the orchestrator loop (`spin_up_agent` tool surface, model routing). No orchestrator/LLM code exists yet.

## Decisions Made

- Orchestrator runs in a lightweight, non-hardened devcontainer (root user, Docker socket mounted, no egress proxy) — this is the trusted tier. Full harness hardening (capability-drop, non-root, egress allowlist) is reserved for the sub-agent containers this code provisions, not applied to this repo's own dev environment. See design doc's "Two-tier container security model."
- `node_modules` is deliberately NOT a Docker volume (named or anonymous) — it lives in the container's own writable layer only, to avoid volume bloat across many future projects. Consequence: a full `docker compose down`/`up` wipes it; `postCreateCommand` runs `npm install` automatically to restore it every time.
- Git identity/push access is set up in this container (identity via mounted `~/.gitconfig` include, auth via `GITHUB_TOKEN` PAT + credential helper baked into the Dockerfile). Sub-agent containers must never get this — see design doc's git-credential boundary section.
- Quality gate (pre-commit hook) is currently warn-only on all branches, including `main` — the branch-protected hard-block was deliberately removed for this first project's early-stage convenience. Flagged as temporary; revisit before this project has real stakes or other contributors.
- Bot identity for git (separate GitHub account for orchestrator commits) considered and deferred — not worth the setup cost yet for a single-user tool. Revisit if commit volume or attribution clarity becomes an issue.
- Credential naming convention: `.env.local`, provider-prefixed uppercase (`GITHUB_TOKEN`, `OPENROUTER_API_KEY`, etc.)
- Sub-agent container assets live in `sandbox/`, ported from `ai-dev-template`. **Follow-up:** once stable, lift `sandbox/Dockerfile` + the proxy assets back into `ai-dev-template` as a published GHCR base image consumed here by pinned digest; this repo's sub-agent Dockerfile then becomes a thin `FROM`. `sandbox/` is the extraction spec.
- Result handoff is an explicit interface (`ResultStore` in `src/types.ts`), not an implicit shared mount — Phase 1 ships `LocalResultStore` (bind-mounted `.orchestrator-runs/<id>/{in,out}`); a cloud backend can replace it without changing `spinUpAgent`.
- Egress proxy is **per run** (one tinyproxy container + one internal network per sub-agent), not a shared long-lived proxy — matches "disposable per task" and makes per-role allowlists trivial later. Revisit if per-run startup latency matters.
- `.orchestrator-runs/` (per-run in/out scratch) is ignored via `.git/info/exclude` (local, uncommitted) to avoid touching the `.gitignore` boundary file.

## Open Questions

- Whether model selection (per-task, cost-driven) lives in the orchestrator's own reasoning or in deterministic provisioning-layer code — noted as undecided in the design doc.
- Exact GitHub PAT scope for eventual "orchestrator creates its own repos" capability — deferred; current token is scoped to this repo only, without repo-creation permission, until that capability is actually being built.
- Sub-agent root filesystem is currently `--read-only` (tmpfs for `/tmp`, `~/.cache`). May need loosening once a real agent runtime is dropped into `sandbox/agent-entrypoint.sh`.
- Engineer role gets `src/` read-write, but repo files are owned by root in this devcontainer while the sub-agent runs as `agent` (uid 1000) — a real engineer task that writes `src/` will need the ownership/uid question resolved (chown-on-prepare, or run the sub-agent as the host uid).
- `OPENROUTER_API_KEY` will be injected into sub-agent containers as a *model* credential — explicitly not covered by the git-credential boundary. Not yet wired (Phase 1 entrypoint is a stub).
- The orchestrator's own tests now live in `tests/`, which is also the directory `src/roles.ts` bind-mounts into test-engineer/reviewer sub-agents. This only collides while the provisioning layer hardcodes the target project to its own `/workspace` (Phase 1, stub only). When the orchestrator loop lands it must resolve the *target* project path separately from the orchestrator repo.

## Recently Completed

- Lightweight devcontainer (Dockerfile, docker-compose.yml, devcontainer.json) built and verified — Docker socket access confirmed working via `docker ps` from inside the container.
- Git hooks (pre-commit secret-block + warn-only quality gate, pre-push force-push block) ported from ai-dev-template and installed via `postCreateCommand`.
- Node/TypeScript/Vitest scaffolding set up; `npm install` automated via `postCreateCommand` given the no-volume decision above.
- Git identity + GitHub PAT push access wired up and confirmed working from inside the container.
- Design doc for the full project (problem, architecture, roles, two-tier security model, git-credential boundary) drafted and iterated.
- **Phase 1 — container provisioning layer.** `src/types.ts` (types + `ResultStore`/`AgentResult` handoff contract), `src/roles.ts` (three role mount/permission profiles + `assertProfileInvariants()` backstop), `src/provisioning.ts` (`spinUpAgent`/`tearDownAgent`/`reap`, `LocalResultStore`, host-path self-resolution, per-run internal network + tinyproxy sidecar, dockerode-based lifecycle). `sandbox/` holds the sub-agent + proxy images (`orq-sandbox:dev`, `orq-proxy:dev`) built by `npm run sandbox:build`. Unit tests (dockerode mocked) in `tests/*.test.ts`; a real-Docker integration suite in `tests/provisioning.integration.test.ts` (`npm run test:integration`) verifies the `:ro` mount boundary, `tests/` absent for engineer, the proxy allowlist (allowed host passes, others 403), and clean teardown. No LLM/orchestrator/CLI-loop code — the sub-agent "agent process" is a stub.
- Housekeeping: `package.json` renamed to `agent-orchestrator` + `bin`/`engines`; `README.md` added; stale design-doc path fixed in `AGENTS.md`; two/three-roles wording reconciled in `docs/DESIGN.md`.
