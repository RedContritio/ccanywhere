import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKEN_TTL_MS,
  resetAuthStoreForTest,
  useAuthStore,
} from './auth.js';

describe('useAuthStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAuthStoreForTest();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('initial state has all-null active session and empty limited list', () => {
    const s = useAuthStore.getState();
    expect(s.deviceId).toBeNull();
    expect(s.label).toBeNull();
    expect(s.kind).toBeNull();
    expect(s.verifiedAt).toBeNull();
    expect(s.ownerDeviceId).toBeNull();
    expect(s.ownerLabel).toBeNull();
    expect(s.limitedUsers).toEqual([]);
  });

  it('setPaired sets active owner identity + mirrors to owner stored slot', () => {
    const before = Date.now() - 1;
    useAuthStore.getState().setPaired('dev-abc', 'laptop');
    const after = useAuthStore.getState();
    expect(after.deviceId).toBe('dev-abc');
    expect(after.label).toBe('laptop');
    expect(after.kind).toBe('owner');
    expect(after.verifiedAt).toBeGreaterThan(before);
    expect(after.ownerDeviceId).toBe('dev-abc');
    expect(after.ownerLabel).toBe('laptop');
  });

  it('setLimitedSession appends one user with one token', () => {
    const token = 'a'.repeat(64);
    const before = Date.now();
    useAuthStore.getState().setLimitedSession('user-1', 'alice', token);
    const s = useAuthStore.getState();
    expect(s.kind).toBe('limited');
    expect(s.deviceId).toBe('user-1');
    expect(s.limitedUsers).toHaveLength(1);
    expect(s.limitedUsers[0]).toMatchObject({
      userId: 'user-1',
      username: 'alice',
      tokens: [{ token }],
    });
    const expiresAt = s.limitedUsers[0]!.tokens[0]!.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TOKEN_TTL_MS - 5);
  });

  it('setLimitedSession accepts custom ttlMs', () => {
    const token = 'a'.repeat(64);
    const customTtl = 60_000;
    const before = Date.now();
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', token, customTtl);
    const expiresAt =
      useAuthStore.getState().limitedUsers[0]!.tokens[0]!.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + customTtl - 5);
    expect(expiresAt).toBeLessThan(before + customTtl + 100);
  });

  it('setLimitedSession(token=null) creates user record with empty tokens', () => {
    useAuthStore.getState().setLimitedSession('user-1', 'alice', null);
    const u = useAuthStore.getState().limitedUsers[0]!;
    expect(u.userId).toBe('user-1');
    expect(u.tokens).toEqual([]);
  });

  it('setLimitedSession with same user appends a new distinct token', () => {
    const t1 = 'a'.repeat(64);
    const t2 = 'b'.repeat(64);
    useAuthStore.getState().setLimitedSession('user-1', 'alice', t1);
    useAuthStore.getState().setLimitedSession('user-1', 'alice', t2);
    const tokens = useAuthStore.getState().limitedUsers[0]!.tokens;
    expect(tokens.map((t) => t.token)).toEqual([t1, t2]);
  });

  it('setLimitedSession with same user + same token bumps expiresAt', () => {
    const token = 'a'.repeat(64);
    useAuthStore.getState().setLimitedSession('user-1', 'alice', token, 1000);
    const e1 = useAuthStore.getState().limitedUsers[0]!.tokens[0]!.expiresAt;
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', token, 60_000);
    const e2 = useAuthStore.getState().limitedUsers[0]!.tokens[0]!.expiresAt;
    expect(e2).toBeGreaterThan(e1);
    // Still a single token (not duplicated).
    expect(useAuthStore.getState().limitedUsers[0]!.tokens).toHaveLength(1);
  });

  it('setLimitedSession with a different user adds a second user record', () => {
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    useAuthStore
      .getState()
      .setLimitedSession('user-2', 'bob', 'b'.repeat(64));
    const users = useAuthStore.getState().limitedUsers;
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.userId)).toEqual(['user-1', 'user-2']);
  });

  it('clearSession drops active session, preserves owner + limitedUsers', () => {
    useAuthStore.getState().setPaired('dev-abc', 'laptop');
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    useAuthStore.getState().clearSession();
    const s = useAuthStore.getState();
    expect(s.deviceId).toBeNull();
    expect(s.kind).toBeNull();
    expect(s.verifiedAt).toBeNull();
    expect(s.ownerDeviceId).toBe('dev-abc');
    expect(s.limitedUsers).toHaveLength(1);
    expect(s.limitedUsers[0]!.tokens).toHaveLength(1);
  });

  it('unpair clears everything (active + stored)', () => {
    useAuthStore.getState().setPaired('dev-abc', 'laptop');
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    useAuthStore.getState().unpair();
    const s = useAuthStore.getState();
    expect(s.deviceId).toBeNull();
    expect(s.ownerDeviceId).toBeNull();
    expect(s.limitedUsers).toEqual([]);
  });

  it('forgetToken removes one token but keeps the user + other tokens', () => {
    const t1 = 'a'.repeat(64);
    const t2 = 'b'.repeat(64);
    useAuthStore.getState().setLimitedSession('user-1', 'alice', t1);
    useAuthStore.getState().setLimitedSession('user-1', 'alice', t2);
    useAuthStore.getState().forgetToken('user-1', t1);
    const u = useAuthStore.getState().limitedUsers[0]!;
    expect(u.tokens.map((t) => t.token)).toEqual([t2]);
  });

  it('forgetLimitedUser drops the user + flushes active session if it was that user', () => {
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    useAuthStore.getState().forgetLimitedUser('user-1');
    const s = useAuthStore.getState();
    expect(s.limitedUsers).toEqual([]);
    expect(s.deviceId).toBeNull();
    expect(s.kind).toBeNull();
  });

  it('forgetLimitedUser keeps active session intact when active user is different', () => {
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    useAuthStore
      .getState()
      .setLimitedSession('user-2', 'bob', 'b'.repeat(64));
    // Active is now user-2 (last setLimitedSession wins).
    useAuthStore.getState().forgetLimitedUser('user-1');
    const s = useAuthStore.getState();
    expect(s.limitedUsers.map((u) => u.userId)).toEqual(['user-2']);
    expect(s.deviceId).toBe('user-2');
    expect(s.kind).toBe('limited');
  });

  it('forgetOwnerCredential drops owner slot + active if owner; leaves limited list', () => {
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    useAuthStore.getState().setPaired('dev-1', 'laptop');
    useAuthStore.getState().forgetOwnerCredential();
    const s = useAuthStore.getState();
    expect(s.ownerDeviceId).toBeNull();
    expect(s.deviceId).toBeNull();
    expect(s.kind).toBeNull();
    expect(s.limitedUsers).toHaveLength(1);
  });

  it('setPaired keeps limitedUsers (dual-credential machine)', () => {
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    useAuthStore.getState().setPaired('dev-abc', 'laptop');
    const s = useAuthStore.getState();
    expect(s.kind).toBe('owner');
    expect(s.ownerDeviceId).toBe('dev-abc');
    expect(s.limitedUsers[0]!.userId).toBe('user-1');
  });

  it('setLimitedSession keeps owner stored slot (dual-credential machine)', () => {
    useAuthStore.getState().setPaired('dev-abc', 'laptop');
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    const s = useAuthStore.getState();
    expect(s.kind).toBe('limited');
    expect(s.ownerDeviceId).toBe('dev-abc');
  });

  it('markVerified bumps verifiedAt without touching deviceId/label', () => {
    useAuthStore.getState().setPaired('dev-1', 'laptop');
    const t1 = useAuthStore.getState().verifiedAt!;
    const start = Date.now();
    while (Date.now() === start) {
      // spin briefly
    }
    useAuthStore.getState().markVerified();
    const after = useAuthStore.getState();
    expect(after.deviceId).toBe('dev-1');
    expect(after.label).toBe('laptop');
    expect(after.verifiedAt).toBeGreaterThan(t1);
  });

  it('persists through localStorage under ccanywhere.auth', () => {
    useAuthStore.getState().setPaired('dev-1', 'phone');
    useAuthStore
      .getState()
      .setLimitedSession('user-1', 'alice', 'a'.repeat(64));
    const raw = localStorage.getItem('ccanywhere.auth');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as {
      state?: { ownerDeviceId?: string; limitedUsers?: unknown[] };
    };
    expect(parsed.state?.ownerDeviceId).toBe('dev-1');
    expect(parsed.state?.limitedUsers).toHaveLength(1);
  });
});
