import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAuthStoreForTest, useAuthStore } from './auth.js';

describe('useAuthStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAuthStoreForTest();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('initial state is fully null', () => {
    const s = useAuthStore.getState();
    expect(s.deviceId).toBeNull();
    expect(s.label).toBeNull();
    expect(s.verifiedAt).toBeNull();
  });

  it('setPaired sets deviceId, label, verifiedAt; logout clears all', () => {
    const before = Date.now() - 1;
    useAuthStore.getState().setPaired('dev-abc', 'laptop');
    const after = useAuthStore.getState();
    expect(after.deviceId).toBe('dev-abc');
    expect(after.label).toBe('laptop');
    expect(after.verifiedAt).toBeGreaterThan(before);

    useAuthStore.getState().logout();
    const cleared = useAuthStore.getState();
    expect(cleared.deviceId).toBeNull();
    expect(cleared.label).toBeNull();
    expect(cleared.verifiedAt).toBeNull();
  });

  it('markVerified bumps verifiedAt without touching deviceId/label', () => {
    useAuthStore.getState().setPaired('dev-1', 'laptop');
    const t1 = useAuthStore.getState().verifiedAt!;
    // Force a measurable gap so the next bump is strictly greater.
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
    const raw = localStorage.getItem('ccanywhere.auth');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as {
      state?: { deviceId?: string; label?: string };
    };
    expect(parsed.state?.deviceId).toBe('dev-1');
    expect(parsed.state?.label).toBe('phone');
  });
});
