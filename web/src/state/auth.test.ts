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
    expect(s.token).toBeNull();
    expect(s.label).toBeNull();
    expect(s.verifiedAt).toBeNull();
  });

  it('login sets token, label, verifiedAt; logout clears all', () => {
    const before = Date.now() - 1;
    useAuthStore.getState().login('tok-abc', 'laptop');
    const after = useAuthStore.getState();
    expect(after.token).toBe('tok-abc');
    expect(after.label).toBe('laptop');
    expect(after.verifiedAt).toBeGreaterThan(before);

    useAuthStore.getState().logout();
    const cleared = useAuthStore.getState();
    expect(cleared.token).toBeNull();
    expect(cleared.label).toBeNull();
    expect(cleared.verifiedAt).toBeNull();
  });

  it('persists through localStorage under ccanywhere.auth', () => {
    useAuthStore.getState().login('tok-1', 'phone');
    const raw = localStorage.getItem('ccanywhere.auth');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as { state?: { token?: string; label?: string } };
    expect(parsed.state?.token).toBe('tok-1');
    expect(parsed.state?.label).toBe('phone');
  });
});
