## Current Task

Building Phase 1 of the multi-agent orchestrator: the container provisioning layer (`src/types.ts`, `src/roles.ts`, `src/provisioning.ts`). Goal is `spinUpAgent`/`tearDownAgent` working against real Docker containers with correct role-based mount permissions, verified by hand (attempt a blocked write from inside a provisioned container and confirm it fails) before any LLM/orchestrator logic is added on top.

## Decisions Made

- Orchestrator runs in a lightweight, non-hardened devcontainer (root user, Docker socket mounted, no egress proxy) — this is the trusted tier. Full harness hardening (capability-drop, non-root, egress allowlist) is reserved for the sub-agent containers this code provisions, not applied to this repo's own dev environment. See design doc's "Two-tier container security model."
- `node_modules` is deliberately NOT a Docker volume (named or anonymous) — it lives in the container's own writable layer only, to avoid volume bloat across many future projects. Consequence: a full `docker compose down`/`up` wipes it; `postCreateCommand` runs `npm install` automatically to restore it every time.
- Git identity/push access is set up in this container (identity via mounted `~/.gitconfig` include, auth via `GITHUB_TOKEN` PAT + credential helper baked into the Dockerfile). Sub-agent containers must never get this — see design doc's git-credential boundary section.
- Quality gate (pre-commit hook) is currently warn-only on all branches, including `main` — the branch-protected hard-block was deliberately removed for this first project's early-stage convenience. Flagged as temporary; revisit before this project has real stakes or other contributors.
- Bot identity for git (separate GitHub account for orchestrator commits) considered and deferred — not worth the setup cost yet for a single-user tool. Revisit if commit volume or attribution clarity becomes an issue.
- Credential naming convention: `.env.local`, provider-prefixed uppercase (`GITHUB_TOKEN`, `OPENROUTER_API_KEY`, etc.)

## Open Questions

- Whether model selection (per-task, cost-driven) lives in the orchestrator's own reasoning or in deterministic provisioning-layer code — noted as undecided in the design doc.
- Exact GitHub PAT scope for eventual "orchestrator creates its own repos" capability — deferred; current token is scoped to this repo only, without repo-creation permission, until that capability is actually being built.

## Recently Completed

- Lightweight devcontainer (Dockerfile, docker-compose.yml, devcontainer.json) built and verified — Docker socket access confirmed working via `docker ps` from inside the container.
- Git hooks (pre-commit secret-block + warn-only quality gate, pre-push force-push block) ported from ai-dev-template and installed via `postCreateCommand`.
- Node/TypeScript/Vitest scaffolding set up; `npm install` automated via `postCreateCommand` given the no-volume decision above.
- Git identity + GitHub PAT push access wired up and confirmed working from inside the container.
- Design doc for the full project (problem, architecture, roles, two-tier security model, git-credential boundary) drafted and iterated.
