# Agent Instructions

## 1. Project Overview

Multi-agent orchestrator CLI. TypeScript/Node. An orchestrator LLM delegates scoped coding tasks to role-based sub-agents (test-engineer, engineer, reviewer), each provisioned as its own isolated Docker container. See `docs/DESIGN.md` for full architecture and rationale.

This repo (`agent-orchestrator`) is the orchestrator/provisioning-layer codebase itself — it is the *trusted* tier described in the design doc's "Two-tier container security model." It is not one of the sandboxed sub-agent environments it provisions.

## 2. Build and Test Commands

No build step yet beyond TypeScript compilation.

```sh
npm run build   # tsc
npm run dev     # tsx src/index.ts
npm test        # vitest run
```

```sh
TEST_CMD="npm test"
LINT_CMD=""
```

`LINT_CMD` intentionally blank until a linter (e.g. ESLint) is added.

## 3. Code Style Guidelines

No style guide beyond language defaults yet. TypeScript `strict: true` is enabled in `tsconfig.json` — do not weaken this to work around a type error; fix the underlying type issue instead.

## 4. Testing Instructions

- Test files live in `tests/`, mirroring `src/`. Unit tests are `tests/*.test.ts`; real-Docker integration tests are `tests/*.integration.test.ts` and are excluded from `npm test` (run `npm run test:integration`).
- `npm test` — unit suite (fast, dockerode mocked). `npm run typecheck` — strict type-check of `src/` + `tests/` (`npm run build` only compiles `src/`).
- Single test file: `npx vitest run <path>`
- Single test by name: `npx vitest run -t "<name>"`
- Mock Docker/dockerode calls in unit tests for provisioning logic — do not have tests spin up real containers unless explicitly writing an integration test, and label such tests clearly as integration tests.

## 5. Boundaries

Do not modify any of the following without explicit confirmation from the user:

- `.devcontainer/` — this container's own sandbox config
- `.githooks/` — enforcement hooks
- `hooks/` — hook scripts
- `docker-compose.yml` — this includes the Docker socket mount; changes here affect what this trusted-tier container can control on the host
- `.gitignore` — modifying this could expose secrets
- CI/CD config files (`.github/`, etc.)
- `tests/` — test files define correctness; do not modify or delete a test to make it pass
- `src/roles.ts` — role mount/permission profiles are the actual security boundary between sub-agent roles (see design doc); changes here directly affect what an engineer-role or reviewer-role sub-agent can access. Treat changes to this file with the same caution as changes to `.devcontainer/`.

## 6. Security Considerations

- Never read, print, or commit files matching: `.env`, `*.env`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*secret*`, `*credential*`, `*token*`
- This container holds `GITHUB_TOKEN` and `OPENROUTER_API_KEY` (via `.env.local`). Never print these values, even partially, in any output.
- `OPENROUTER_API_KEY` is injected into proxy-network sub-agent containers as a *model* credential. It is explicitly NOT covered by the git-credential boundary below (git is) — but it must still never appear in logs, `task.json`, or committed files.
- Per the design doc's git-credential boundary: only this orchestrator container performs git operations. Sub-agent containers this code provisions must never receive git credentials or perform git operations themselves — this is a hard architectural rule, not a preference, when writing or modifying provisioning logic.
- To extend network access for this container, edit `docker-compose.yml` directly (this container has no egress proxy — see design doc's two-tier model for why).

## 7. Commit and PR Guidelines

- Branch naming: `type/short-description` (e.g. `feat/spin-up-agent`, `fix/mount-config`)
- Commits: conventional commits format (`feat:`, `fix:`, `chore:`, `docs:`, etc.)
- Every AI-assisted change gets logged in `docs/CHANGES.md` after review
- Direct pushes to `main` are currently allowed (quality gate is warn-only on all branches, including `main`, as a deliberate temporary relaxation for early-stage development on this first project — see `docs/CONTEXT.md` for status). Revisit before this project has real stakes or other contributors.
