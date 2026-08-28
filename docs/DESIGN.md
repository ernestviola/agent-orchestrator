# Multi-Agent Orchestrator CLI — Design Doc

## Problem

Working with AI coding agents today has three unresolved gaps:

1. **No cost control.** Every task — trivial boilerplate or genuine architecture decisions — runs through whatever single model/tool is open, regardless of what the task actually needs. There's no mechanism to route cheap tasks to cheap models and reserve expensive models for tasks that need them.
2. **Provider lock-in.** Experience so far is Claude-ecosystem-only, with no easy way to route across providers by price or capability without hand-building per-provider integrations.
3. **No structural test integrity.** An agent with write access to both implementation and tests can silently weaken or delete a failing test to reach "green," and nothing beyond the agent's own good behavior prevents this. Instructions ("don't modify tests") are advisory, not enforced — this surfaced directly while testing the ai-dev-template harness on a toy project.

## Approach

A CLI-based orchestrator that delegates work to role-scoped sub-agents, each running in its own fully isolated, disposable container — never in the orchestrator's own process or file access.

```
User ↔ Orchestrator (LLM, reasons out a build plan with the user)
              │
              │ spin_up_agent(role, task)  — a deterministic tool call,
              │ not a raw shell/docker command the orchestrator runs itself
              ▼
      Container provisioning layer (code, not LLM-controlled)
              │
     ┌────────┼────────────────┬──────────────────┐
     ▼                         ▼                  ▼
 Test Engineer sandbox   Engineer sandbox    Reviewer sandbox
 (tests/: read-write      (src/: read-write   (everything:
  src/: read-only)         tests/: none)       read-only)
     │
     ▼
 ── HUMAN APPROVAL GATE ──
 (required stop: user reviews/approves
  drafted tests before they are locked
  and the engineer role is spun up)
```

**Orchestrator** — an LLM that does two things: reasons out a build plan conversationally with the user, and delegates scoped tasks to sub-agents by calling a `spin_up_agent(role, task)` tool. The orchestrator decides _what_ to delegate and _to which role_ — it does not directly issue container commands. What each role is allowed to touch is fixed by the provisioning layer's code, not by the orchestrator's prompt or judgment. This mirrors the same principle that motivated the whole project: enforcement has to be mechanical, not something an LLM is merely instructed to respect.

**Container provisioning layer** — deterministic code (not an LLM) that takes a role name and stands up a real, separate container with that role's fixed mount/permission profile. Built on the same devcontainer + egress-proxy pattern already established for the ai-dev-template harness — this isn't a new isolation mechanism, it's the existing one, invoked per sub-agent task instead of once per human session. Because it's a real container (not a shared process with scoped permissions), the same mechanism works locally or against a cloud provisioning API later — the interface (`spin_up_agent`) doesn't change, only what backs it.

**Sub-agents** — each is a single-purpose agent running inside its own container, given only the task and the context it needs, nothing more. It reports results back to the orchestrator on completion; its container is disposable and torn down afterward (or kept briefly for the user to inspect, depending on outcome).

## Git credentials and result handoff — a hard boundary

**Sub-agents never receive git credentials, and never perform git operations themselves.** Only the orchestrator (running in the trusted, lighter container) authenticates to GitHub and runs `git add`/`commit`/`push`. This follows the same principle as the role-based file permissions: don't rely on an agent behaving well when the alternative is making the unsafe action structurally impossible. A sub-agent compromised by a prompt injection, a bug, or simple misdirection cannot leak or misuse a credential it was never given.

This has a direct consequence for how sub-agent results get back to the orchestrator, and it's a constraint on the `spin_up_agent` interface itself, not just an implementation detail of the local version:

- **Locally**, this is nearly free: sub-agent containers share bind-mounted directories with the host, so the orchestrator can read a sub-agent's resulting files directly off disk once its container exits — no data transfer step, no credential ever enters the sub-agent's container.
- **On a cloud backend**, sub-agent compute won't share a filesystem with the orchestrator. The result-handoff mechanism has to become explicit — e.g., the sub-agent writes its output to a designated location (object storage, a structured return payload the orchestrator fetches once the job completes) rather than assuming a shared mount. The boundary (sub-agent never touches git, never holds a git credential) stays identical; only the plumbing for getting its output back changes.

Because of this, **the provisioning layer's interface must define result handoff as an explicit contract** (how a sub-agent's output is retrieved once it completes) rather than leaving it implicit in "shared mounts happen to make this easy locally." Building the local version without this made explicit risks baking in a filesystem assumption that quietly breaks when a cloud backend is added later.

## Roles (v1 scope: three)

**Test Engineer**

- Mount: `tests/` read-write, `src/` read-only (needs to see existing code/interfaces for context, but cannot implement against what it writes).
- Task: given requirements from the orchestrator/user conversation, write tests that capture them.
- Output is **not** automatically trusted downstream — see the human approval gate below.

**Human approval gate (required, not an agent)**

- The orchestrator presents the test engineer's drafted tests to the user for review before anything proceeds.
- Work does not continue to the engineer role until the user approves (or the tests are revised and re-approved).
- This is the step that preserves the actual safety property the whole design is built around: an independent, trusted anchor for correctness. Without a human checkpoint here, "a test-engineer agent writes the tests" just relocates the trust problem instead of resolving it — nothing would stop a test-engineer agent from writing weak or trivially-satisfiable tests, imperfectly rather than maliciously, and nothing downstream would catch it. This gate is non-negotiable in v1, not a nicety to skip once things feel like they're working.
- Once approved, tests are locked (treated as fixed input to the engineer role, same as a human-written test file today).

**Engineer**

- Mount: `src/` read-write.
- `tests/` is not mounted, or mounted read-only if the task genuinely needs to read (not modify) existing tests for context.
- Task: implement or modify code to satisfy the given, now-locked, human-approved set of tests.

**Reviewer**

- Mount: everything, read-only. No write access anywhere.
- Task: given a diff (or the current state of `src/` against `tests/`), assess whether the change plausibly satisfies the unchanged tests and flag anything suspicious (e.g., overly narrow implementation, hardcoded outputs matching only the given test cases).
- Deliberately has no ability to "fix" anything it flags — it can only report back to the orchestrator or the user.

This role split, plus the human approval gate, is a direct, structural answer to the test-integrity problem: the engineer role gets `tests/` **read-only** (it can read the locked tests and run them to verify, but the mount mode makes modifying or deleting one physically impossible), the reviewer role is physically incapable of writing anything at all, and the one role that _can_ write tests never gets to hand them straight to implementation without a human in the loop. None of these properties depend on any agent behaving well.

## Model routing

Per sub-agent task, not global. The orchestrator (or the provisioning layer, TBD during implementation) selects a model based on task complexity — e.g., a cheap/fast model for a well-specified, narrow engineering task, a stronger model for one requiring judgment or ambiguity resolution.

Routed via **OpenRouter**, using **BYOK** (bring-your-own-key) for providers where a direct API key already exists (e.g., Anthropic) — this avoids OpenRouter's credit-purchase fee entirely for that usage while still getting unified routing and easy model-switching for anything routed through providers without a direct key. OpenRouter's per-token pricing otherwise passes through at the underlying provider's list price, so routing itself doesn't introduce a cost penalty beyond the BYOK/credit distinction.

Cost-tier escalation logic (start with the cheapest plausible model, escalate only if it fails) is a reasonable v1-or-soon pattern, but per the user's own prioritization, full cost-control logic can be layered in incrementally after basic routing exists — it doesn't block v1.

## What v1 does NOT include

- **More than three roles.** Marketing, security, researcher, docs-writer, deployer, and "agent builder" roles are noted as future directions, not scoped for v1. Each additional role needs its own mount/permission profile designed deliberately, not by analogy.
- **Cloud container provisioning.** V1 targets local Docker, same as the ai-dev-template harness. The provisioning layer's interface should be designed so a cloud backend can be swapped in later without changing how the orchestrator calls it — but the cloud backend itself is not built in v1.
- **Full cost-tier escalation logic.** Basic per-task model selection ships in v1; automatic cascading (try cheap model, escalate on failure) is a follow-on.
- **Multi-agent parallelism / complex task graphs.** V1 assumes the orchestrator delegates one task to one sub-agent at a time and waits for a result, not multiple sub-agents working concurrently on interdependent pieces.
- **A "skills" system.** The earlier idea of loadable skills (named capabilities/prompt templates a role can draw on) is not part of v1's three fixed roles. Worth revisiting once the three-role orchestration loop itself is proven.

## Two-tier container security model

The orchestrator/provisioning layer and the sub-agent containers it creates have different threat models and are deliberately hardened differently:

**Orchestrator/provisioning container (lighter)** — runs trusted, human-written infrastructure code, not untrusted LLM-generated actions. It needs the Docker socket mounted (`-v /var/run/docker.sock:/var/run/docker.sock`) to create and tear down sibling sub-agent containers on the host's Docker daemon. This is a real trade-off worth naming: socket access effectively grants broad host control, which is why it's confined to this one trusted component rather than mounted into every container in the system. Network access can be more permissive than the sub-agent proxy allowlist (needs to reach OpenRouter, Docker registries, etc.) since it's not running arbitrary agent-generated commands. Non-root user is still worth keeping; full capability-dropping may need to be relaxed if it interferes with Docker socket operations — verify this doesn't unexpectedly weaken things further than intended.

**Sub-agent containers (full harness)** — where arbitrary LLM-generated actions actually execute. These get the complete ai-dev-template hardening: capability-dropped, non-root, egress-proxy with domain allowlisting, role-scoped read-only/read-write mounts. This is the isolation boundary the project's core safety property (structural test integrity) actually depends on.

Developing the provisioning layer inside a full sandbox (with the Docker socket mounted) would undermine the isolation it's meant to preserve, so it's built and run with lighter constraints instead — the strict harness is reserved for the untrusted work it provisions, not for itself.

## Deferred decisions

**Separate bot identity for git operations.** Considered using a dedicated GitHub account/identity for the orchestrator's commits and pushes (rather than a PAT under the user's own account), for cleaner attribution and independent credential lifecycle as the orchestrator's access list grows. Not adopted for now — this is a personal tool, not yet at the point where autonomous commit volume or blast-radius concerns justify the setup cost. Revisit if the orchestrator starts committing at a volume or on projects where "authored by me" attribution becomes misleading, or if credential rotation/revocation needs to happen independently of the user's personal GitHub access.

## Credential conventions

All orchestrator credentials live in `.env.local` (gitignored), using provider-prefixed uppercase names matching common SDK defaults where one exists:

```
GITHUB_TOKEN=...
OPENROUTER_API_KEY=...
```

Future access points (cloud provider APIs, etc.) follow the same convention.

## Relationship to the existing ai-dev-template harness

This project reuses the harness's isolation primitives (devcontainer, capability-dropped non-root containers, egress proxy with domain allowlisting, git hooks) rather than inventing new ones. The meaningful addition here is **role-based mount/permission profiles per container** and **an orchestrator that provisions containers programmatically** rather than a human opening one devcontainer per session. Everything learned from hardening the template (the `sleep infinity` requirement, `FilterType fnmatch`, non-root capability handling, credential injection via env vars rather than disk) applies directly to each sub-agent container here.
