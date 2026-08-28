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

## Using the orchestrator

### Prerequisites

1. Run inside the devcontainer (needs the mounted Docker socket and the `/workspace` bind mount).
2. `OPENROUTER_API_KEY` in `.env.local` — a *model* credential, not the git-credential boundary.
   Restart the devcontainer after adding it (compose reads `env_file` only at container start).
   Optionally set `ORQ_ORCHESTRATOR_MODEL` (orchestrator LLM) and `ORQ_MODEL` (sub-agents);
   both default to `anthropic/claude-haiku-4.5`.
3. Build the sub-agent images once (rebuild after changing anything under `sandbox/`):

   ```sh
   npm run sandbox:build
   ```

4. A **target project** to work on, inside `/workspace` (only in-repo paths are wired), with an
   `orq-project.json` at its root:

   ```jsonc
   {
     "testCmd": "npm test",
     "srcDir": "src",
     "testsDir": "tests",
     // optional — paths the testCmd needs, mounted read-only from the real target:
     "sandboxReadonlyPaths": ["package.json", "tsconfig.json", "vitest.config.ts"],
     // optional — paths the testCmd writes into; copied into the throwaway working copy:
     "sandboxWritablePaths": ["node_modules"]
   }
   ```

   `node_modules` goes in `sandboxWritablePaths` (Vite/Vitest bundle the config into
   `node_modules/.vite-temp`). Each path must exist in the target and is rejected if it looks
   like a credential file. `fixtures/sample-project/` (no deps) and this repo's own root
   `orq-project.json` are worked examples.

### Start a session

```sh
npm run dev -- --orchestrate <path-to-target-project>
# e.g.
npm run dev -- --orchestrate fixtures/sample-project
```

You get a `>` prompt. Describe what you want built in plain language. An LLM plans with you and
delegates scoped tasks to sub-agents through a single `spin_up_agent(role, task, context?)`
tool — it never runs code or shells out itself. Type `exit` (or Ctrl-D) to quit.

### Walkthrough

```
$ npm run dev -- --orchestrate fixtures/sample-project
orchestrator ready (model: anthropic/claude-haiku-4.5, target: fixtures/sample-project).
Describe what you want built. Ctrl-D or "exit" to quit.

> Add a test that fizzbuzz(-3) returns "Fizz", and once I approve it, implement it so every test passes.

─────────────── HUMAN APPROVAL GATE ───────────────
test-engineer run mtcb9oip-2c3b7c73 — completed
summary: Added test asserting that fizzbuzz(-3) returns 'Fizz'
<unified diff of the drafted tests>
───────────────────────────────────────────────────
Approve these drafted tests for the engineer? [y/N] y
approved — tests locked.

<the engineer runs against the locked tests and the orchestrator reports back>

> exit
bye
```

### The approval gate

- After every **completed** `test-engineer` run, the CLI shows you the drafted tests as a diff
  and asks for approval. `y` / `yes` locks them; anything else rejects.
- A `spin_up_agent` call for `role: "engineer"` is **refused in code** (in the tool handler,
  not by asking the model nicely) until a test-engineer run this session has been approved.
- If you're implementing against tests you wrote yourself, just say so — with no test-engineer
  run in the session the orchestrator goes straight to the engineer.
- Re-running the test-engineer re-opens the gate until you approve the new set.
- Answering the gate prompt with EOF (Ctrl-D) counts as **not approved**.

### Getting the changes out

Sub-agents edit a **working copy** — your real files are never touched and nothing is committed.
Each run's artifacts land in `.orchestrator-runs/<run-id>/out/` (`status.json`, `diff.patch`,
`agent.log`). To apply a change you review its diff and commit it yourself. (Auto-applying an
approved diff is a follow-up.)

### Driving one sub-agent directly (no planning, no gate)

Handy for development — skips the orchestrator entirely:

```sh
npm run dev -- --engineer      fixtures/sample-project "Implement fizzbuzz so the tests pass"
npm run dev -- --test-engineer fixtures/sample-project "Add tests asserting fizzbuzz coerces its output to a string"
npm run dev -- --reap          # clean up orphaned containers / networks
```

`--engineer` edits `src/` (and reads `tests/` read-only to verify) and loops until `testCmd`
passes; `--test-engineer` edits `tests/` once (its drafted tests are expected to fail until an
engineer implements the code). The printed result includes a diff; the real project on disk is
never modified. `npm run dev -- --engineer .` runs against this repo itself.

## Development

```sh
npm install
npm run build              # tsc — compiles src/ to dist/ (strict)
npm run typecheck          # strict type-check of src/ + tests/ (no emit)
npm test                   # unit tests (tests/*.test.ts) — dockerode mocked, no real containers
npm run sandbox:build      # build the sub-agent + proxy images (orq-sandbox:dev, orq-proxy:dev)
npm run test:integration   # integration tests (tests/*.integration.test.ts) — real Docker; run sandbox:build first
```

## Status

The provisioning layer, the **engineer** + **test-engineer** slices, the **orchestrator loop +
human approval gate**, and **sandbox dependency support** all work end to end with a real
model — including `--orchestrate .` against this repo itself. No **reviewer** runtime yet, and
`testCmd` doesn't yet run a typecheck inside the sub-agent — see `docs/CONTEXT.md`.
