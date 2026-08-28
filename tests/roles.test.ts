import { describe, expect, it } from 'vitest';

import { ROLE_PROFILES, assertProfileInvariants, getRoleProfile } from '../src/roles.js';
import { ROLES, type RoleProfile } from '../src/types.js';

const clone = (p: RoleProfile): RoleProfile => structuredClone(p);

describe('ROLE_PROFILES', () => {
  it('defines exactly the three v1 roles', () => {
    expect(Object.keys(ROLE_PROFILES).sort()).toEqual([...ROLES].sort());
  });

  it('passes its own invariant check', () => {
    expect(() => assertProfileInvariants()).not.toThrow();
  });

  it('every profile is non-root, cap-drops ALL, and has a read-only rootfs', () => {
    for (const role of ROLES) {
      const p = getRoleProfile(role);
      expect(p.user).toBe('agent');
      expect(p.capDrop).toContain('ALL');
      expect(p.readonlyRootfs).toBe(true);
    }
  });

  it('engineer can write src/ and reads tests/ read-only (cannot modify a test)', () => {
    const p = getRoleProfile('engineer');
    expect(p.mounts.find((m) => m.hostSubpath === 'src')?.mode).toBe('rw');
    expect(p.mounts.find((m) => m.hostSubpath === 'tests')?.mode).toBe('ro');
    expect(p.mounts.some((m) => m.hostSubpath === 'tests' && m.mode === 'rw')).toBe(false);
  });

  it('test-engineer can write tests/ but only reads src/', () => {
    const p = getRoleProfile('test-engineer');
    expect(p.mounts.find((m) => m.hostSubpath === 'tests')?.mode).toBe('rw');
    expect(p.mounts.find((m) => m.hostSubpath === 'src')?.mode).toBe('ro');
    expect(p.network).toBe('proxy');
  });

  it('reviewer has no writable mount and no network', () => {
    const p = getRoleProfile('reviewer');
    expect(p.mounts.every((m) => m.mode === 'ro')).toBe(true);
    expect(p.network).toBe('none');
  });

  it('getRoleProfile rejects an unknown role', () => {
    // @ts-expect-error — deliberately off-type
    expect(() => getRoleProfile('marketing')).toThrow(/unknown role/);
  });
});

describe('assertProfileInvariants (backstop against edits)', () => {
  it('throws if engineer is given a read-write tests/ mount (read-only is allowed)', () => {
    const bad = { ...ROLE_PROFILES, engineer: clone(ROLE_PROFILES.engineer) };
    bad.engineer.mounts.push({ hostSubpath: 'tests', containerPath: '/workspace/tests', mode: 'rw' });
    expect(() => assertProfileInvariants(bad)).toThrow(/engineer must not mount tests\/ read-write/);
  });

  it('throws if reviewer is given a read-write mount', () => {
    const bad = { ...ROLE_PROFILES, reviewer: clone(ROLE_PROFILES.reviewer) };
    bad.reviewer.mounts[0]!.mode = 'rw';
    expect(() => assertProfileInvariants(bad)).toThrow(/reviewer must have no read-write mount/);
  });

  it('throws if reviewer is given network access', () => {
    const bad = { ...ROLE_PROFILES, reviewer: clone(ROLE_PROFILES.reviewer) };
    bad.reviewer.network = 'proxy';
    expect(() => assertProfileInvariants(bad)).toThrow(/reviewer must have no network/);
  });

  it('throws if a profile runs as root', () => {
    const bad = { ...ROLE_PROFILES, engineer: clone(ROLE_PROFILES.engineer) };
    bad.engineer.user = 'root';
    expect(() => assertProfileInvariants(bad)).toThrow(/non-root/);
  });

  it('throws if a profile stops dropping ALL capabilities', () => {
    const bad = { ...ROLE_PROFILES, engineer: clone(ROLE_PROFILES.engineer) };
    bad.engineer.capDrop = ['NET_RAW'];
    expect(() => assertProfileInvariants(bad)).toThrow(/drop ALL capabilities/);
  });

  it('throws if a profile drops its read-only rootfs', () => {
    const bad = { ...ROLE_PROFILES, engineer: clone(ROLE_PROFILES.engineer) };
    bad.engineer.readonlyRootfs = false;
    expect(() => assertProfileInvariants(bad)).toThrow(/read-only root filesystem/);
  });

  it('throws if a mount escapes the project root', () => {
    const bad = { ...ROLE_PROFILES, engineer: clone(ROLE_PROFILES.engineer) };
    bad.engineer.mounts[0]!.hostSubpath = '../secrets';
    expect(() => assertProfileInvariants(bad)).toThrow(/safe relative path/);
  });
});
