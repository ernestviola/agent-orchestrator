/**
 * Role mount / permission profiles — the actual security boundary between sub-agent
 * roles (docs/DESIGN.md → "Roles"). Per AGENTS.md §5 this file is treated with the
 * same caution as `.devcontainer/`: changes here directly change what an
 * engineer-role or reviewer-role sub-agent can access.
 *
 * Design intent enforced structurally, not by agent good behaviour:
 *   - `engineer` is physically incapable of touching `tests/` — `tests/` is not in
 *     its mount list at all.
 *   - `reviewer` is physically incapable of writing anything — every mount is `ro`
 *     and it has no network.
 *   - `test-engineer` can write `tests/` but only sees `src/` read-only.
 *
 * Each profile is written as an explicit literal (no spreading one into another) so a
 * diff to this file is unambiguous. `assertProfileInvariants()` runs at module load
 * and throws if any of the above is violated.
 */
import type { MountSpec, Role, RoleProfile } from './types.js';

const CAP_DROP_ALL = ['ALL'];
const AGENT_USER = 'agent';
/** 2 GiB — enough for a build/test cycle, low enough to bound a runaway. */
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PIDS_LIMIT = 512;

const SRC_RO: MountSpec = { hostSubpath: 'src', containerPath: '/workspace/src', mode: 'ro' };
const SRC_RW: MountSpec = { hostSubpath: 'src', containerPath: '/workspace/src', mode: 'rw' };
const TESTS_RO: MountSpec = { hostSubpath: 'tests', containerPath: '/workspace/tests', mode: 'ro' };
const TESTS_RW: MountSpec = { hostSubpath: 'tests', containerPath: '/workspace/tests', mode: 'rw' };

export const ROLE_PROFILES: Record<Role, RoleProfile> = {
  'test-engineer': {
    role: 'test-engineer',
    mounts: [TESTS_RW, SRC_RO],
    network: 'proxy',
    user: AGENT_USER,
    capDrop: CAP_DROP_ALL,
    readonlyRootfs: true,
    memoryBytes: DEFAULT_MEMORY_BYTES,
    pidsLimit: DEFAULT_PIDS_LIMIT,
  },
  engineer: {
    role: 'engineer',
    // tests/ deliberately absent — the engineer cannot see or modify tests.
    mounts: [SRC_RW],
    network: 'proxy',
    user: AGENT_USER,
    capDrop: CAP_DROP_ALL,
    readonlyRootfs: true,
    memoryBytes: DEFAULT_MEMORY_BYTES,
    pidsLimit: DEFAULT_PIDS_LIMIT,
  },
  reviewer: {
    role: 'reviewer',
    mounts: [SRC_RO, TESTS_RO],
    network: 'none',
    user: AGENT_USER,
    capDrop: CAP_DROP_ALL,
    readonlyRootfs: true,
    memoryBytes: DEFAULT_MEMORY_BYTES,
    pidsLimit: DEFAULT_PIDS_LIMIT,
  },
};

export function getRoleProfile(role: Role): RoleProfile {
  const profile = ROLE_PROFILES[role];
  if (!profile) throw new Error(`unknown role: ${String(role)}`);
  return profile;
}

/**
 * Fails loudly at module load if any profile drifts from the design's structural
 * guarantees. This is a backstop for accidental edits to the literals above.
 */
export function assertProfileInvariants(profiles: Record<Role, RoleProfile> = ROLE_PROFILES): void {
  for (const [key, profile] of Object.entries(profiles) as [Role, RoleProfile][]) {
    const where = `ROLE_PROFILES.${key}`;

    if (profile.role !== key) {
      throw new Error(`${where}: role field "${profile.role}" does not match key`);
    }
    if (!profile.capDrop.includes('ALL')) {
      throw new Error(`${where}: must drop ALL capabilities`);
    }
    if (!profile.user || profile.user === 'root' || profile.user === '0') {
      throw new Error(`${where}: must run as a non-root user`);
    }
    if (!profile.readonlyRootfs) {
      throw new Error(`${where}: must use a read-only root filesystem`);
    }
    for (const m of profile.mounts) {
      if (m.hostSubpath.startsWith('/') || m.hostSubpath.includes('..')) {
        throw new Error(`${where}: mount hostSubpath "${m.hostSubpath}" must be a safe relative path`);
      }
    }

    if (key === 'engineer' && profile.mounts.some((m) => m.hostSubpath === 'tests')) {
      throw new Error(`${where}: engineer must not mount tests/ (structural test integrity)`);
    }
    if (key === 'reviewer') {
      if (profile.mounts.some((m) => m.mode === 'rw')) {
        throw new Error(`${where}: reviewer must have no read-write mount`);
      }
      if (profile.network !== 'none') {
        throw new Error(`${where}: reviewer must have no network`);
      }
    }
  }
}

assertProfileInvariants();
