/**
 * Shared types for the container provisioning layer.
 *
 * The one non-obvious piece here is the **result-handoff contract** (`ResultStore` /
 * `AgentResult`). `docs/DESIGN.md` requires that retrieving a sub-agent's output be an
 * explicit interface rather than an implicit "we happen to share a bind mount", so a
 * cloud provisioning backend can replace the local implementation later without
 * changing how the orchestrator calls `spinUpAgent`.
 */

/** The three v1 sub-agent roles (docs/DESIGN.md → "Roles"). */
export type Role = 'test-engineer' | 'engineer' | 'reviewer';

export const ROLES: readonly Role[] = ['test-engineer', 'engineer', 'reviewer'];

export type MountMode = 'ro' | 'rw';

export interface MountSpec {
  /** Path relative to the project root on the host, e.g. `"src"` or `"tests"`. */
  hostSubpath: string;
  /** Absolute path inside the sub-agent container, e.g. `"/workspace/src"`. */
  containerPath: string;
  mode: MountMode;
}

/** Whether a role's container reaches the network, and how. */
export type NetworkPolicy =
  /** Egress only through the per-run allowlist proxy. */
  | 'proxy'
  /** No network at all (`--network none`). */
  | 'none';

/**
 * A role's fixed mount / permission profile. These are the actual security boundary
 * between sub-agent roles — defined as data in `src/roles.ts`, which is treated with
 * the same caution as `.devcontainer/` (see AGENTS.md §5).
 */
export interface RoleProfile {
  role: Role;
  /** Role-scoped project mounts. The per-run `/task` (ro) and `/out` (rw) dirs are
   *  added by the provisioning layer and are deliberately NOT part of this list. */
  mounts: MountSpec[];
  network: NetworkPolicy;
  /** Container user (name or uid). Always non-root. */
  user: string;
  /** Linux capabilities to drop. Always `['ALL']` in v1. */
  capDrop: string[];
  /** Mount the container root filesystem read-only. */
  readonlyRootfs: boolean;
  /** Hard memory ceiling in bytes. */
  memoryBytes?: number;
  /** Max process count (fork-bomb guard). */
  pidsLimit?: number;
}

/**
 * The job description written to `in/task.json` and bind-mounted read-only at
 * `/task/task.json` in the sub-agent. Never contains credentials of any kind.
 */
export interface TaskSpec {
  /** Natural-language description of the work. */
  task: string;
  /** Optional supporting context (file excerpts, requirements, a diff to review). */
  context?: string;
}

export interface SpinUpParams {
  role: Role;
  task: TaskSpec;
  /**
   * Orchestrator-local path to the target project root (the repo the sub-agent works
   * on). Must contain an `orq-project.json` manifest. Defaults to the orchestrator's
   * own `/workspace` (self-resolved) when omitted.
   */
  projectPath?: string;
  /** Override the model id from `selectModel()` / the `ORQ_MODEL` env default. */
  model?: string;
  /** Wall-clock limit for the sub-agent container. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Shape of a target project's `orq-project.json`. */
export interface ProjectManifest {
  /** Command the sub-agent runs to check its work, from the project root. */
  testCmd: string;
  /** Source dir relative to the project root (mounted read-write for the engineer). */
  srcDir: string;
  /** Tests dir relative to the project root. */
  testsDir: string;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type AgentStatus =
  /** Container exited 0 and produced a well-formed `status.json`. */
  | 'completed'
  /** Container exited non-zero, or its output was missing/malformed. */
  | 'failed'
  /** Container was killed after exceeding `timeoutMs`. */
  | 'timeout';

/** What `spinUpAgent` resolves to. */
export interface AgentResult {
  runId: string;
  role: Role;
  status: AgentStatus;
  /** Container exit code; `null` if it never produced one (e.g. killed on timeout). */
  exitCode: number | null;
  /** Short human-readable summary the sub-agent wrote into `out/status.json`. */
  summary: string;
  /**
   * Unified diff of the sub-agent's working copy against the original target, over
   * both `src/` and `tests/`. Only the role's writable subtree can differ (engineer
   * → `src/`, test-engineer → `tests/`). Empty string when nothing changed. This is
   * the reviewable artifact the human approval gate will consume.
   */
  diff: string;
  /** How many agent loop iterations ran (from `out/status.json`), when reported. */
  iterations?: number;
  /** Orchestrator-local path to the retrieved output artifacts (`status.json`,
   *  `diff.patch`, `agent.log`, `container.log`). */
  outputDir: string;
  startedAt: string;
  finishedAt: string;
}

/** Lifecycle facts the provisioning layer knows and the store does not. */
export interface RunContext {
  role: Role;
  status: AgentStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
}

/** Options passed to `ResultStore.prepare` — everything it needs to stage a run's
 *  inputs (the working copy of the target project) alongside the in/out dirs. */
export interface PrepareOptions {
  /** Orchestrator-local path to the target project root. */
  projectPath: string;
  manifest: ProjectManifest;
}

export interface PreparedRun {
  /** Read/write these from the orchestrator process. */
  inDir: string;
  outDir: string;
  /** Staged working copy of the target project (`workDir/src`, `workDir/tests`). The
   *  sub-agent edits this copy, never the real target. */
  workDir: string;
  /**
   * Bind-mount sources to hand to the container runtime. The container runtime here
   * talks to the *host* Docker daemon, so these are host-absolute paths, which are
   * not the same as `inDir` / `outDir` / `workDir` when the orchestrator itself runs
   * in a container. A cloud `ResultStore` would leave this undefined and stage /
   * collect by another mechanism (a volume, object storage).
   */
  mountSources?: { inDir: string; outDir: string; workDir: string };
}

/**
 * The explicit result-handoff contract. `spinUpAgent` writes the task via `prepare`
 * and retrieves output via `finalize` — it never reads a shared mount directly.
 *
 * - Local: `prepare` makes `.orchestrator-runs/<id>/{in,out,work}` and copies the
 *   target `src/`+`tests/` into `work/`; `finalize` reads `out/status.json` and diffs
 *   `work/src` against the original.
 * - Cloud (later): `prepare` allocates a volume / object-storage prefix and seeds it;
 *   `finalize` fetches the sub-agent's return payload. `spinUpAgent`'s signature does
 *   not change.
 */
export interface ResultStore {
  prepare(runId: string, opts: PrepareOptions): Promise<PreparedRun>;
  finalize(runId: string, ctx: RunContext): Promise<AgentResult>;
  cleanup(runId: string): Promise<void>;
}
