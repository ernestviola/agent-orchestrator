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
  /** Wall-clock limit for the sub-agent container. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
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
  /** Orchestrator-local path to the retrieved output artifacts. */
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

export interface PreparedRun {
  /** Read/write these from the orchestrator process. */
  inDir: string;
  outDir: string;
  /**
   * Bind-mount sources to hand to the container runtime. The container runtime here
   * talks to the *host* Docker daemon, so these are host-absolute paths, which are
   * not the same as `inDir` / `outDir` when the orchestrator itself runs in a
   * container. A cloud `ResultStore` would leave this undefined and inject the task
   * / collect the result by another mechanism.
   */
  mountSources?: { inDir: string; outDir: string };
}

/**
 * The explicit result-handoff contract. `spinUpAgent` writes the task via `prepare`
 * and retrieves output via `finalize` — it never reads a shared mount directly.
 *
 * - Local (Phase 1): `prepare` makes `.orchestrator-runs/<id>/{in,out}`; `finalize`
 *   reads `out/status.json` and enumerates artifacts.
 * - Cloud (later): `prepare` allocates an object-storage prefix; `finalize` fetches
 *   the sub-agent's return payload. `spinUpAgent`'s signature does not change.
 */
export interface ResultStore {
  prepare(runId: string): Promise<PreparedRun>;
  finalize(runId: string, ctx: RunContext): Promise<AgentResult>;
  cleanup(runId: string): Promise<void>;
}
