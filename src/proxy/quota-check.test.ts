import { describe, expect, it } from 'vitest';
import {
  QuotaExceededError,
  UnknownUserError,
  type UsageState,
  type UsageStore,
  checkQuota,
} from './quota-check.js';

function mkStore(records: Record<string, UsageState | null>): UsageStore {
  return {
    getUsage: async (userId: string) => records[userId] ?? null,
  };
}

const future = Date.now() + 60_000;

describe('checkQuota', () => {
  it('throws UnknownUserError for unknown userId (fail-closed, )', async () => {
    const store = mkStore({});
    await expect(checkQuota({ userId: 'ghost', store })).rejects.toThrow(
      UnknownUserError,
    );
  });

  it('throws UnknownUserError when store explicitly returns null', async () => {
    const store = mkStore({ alice: null });
    await expect(checkQuota({ userId: 'alice', store })).rejects.toThrow(
      UnknownUserError,
    );
  });

  it('passes through when limit is null (unlimited admin override)', async () => {
    const store = mkStore({
      alice: { used: 9999, limit: null, resetAt: future },
    });
    await expect(
      checkQuota({ userId: 'alice', store }),
    ).resolves.toBeUndefined();
  });

  it('passes through when used < limit', async () => {
    const store = mkStore({
      alice: { used: 3, limit: 10, resetAt: future },
    });
    await expect(
      checkQuota({ userId: 'alice', store }),
    ).resolves.toBeUndefined();
  });

  it('throws QuotaExceededError when used === limit', async () => {
    const store = mkStore({
      alice: { used: 10, limit: 10, resetAt: future },
    });
    await expect(checkQuota({ userId: 'alice', store })).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it('throws QuotaExceededError when used > limit (overshoot)', async () => {
    const store = mkStore({
      alice: { used: 15, limit: 10, resetAt: future },
    });
    const err = await checkQuota({ userId: 'alice', store }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    if (err instanceof QuotaExceededError) {
      expect(err.userId).toBe('alice');
      expect(err.used).toBe(15);
      expect(err.limit).toBe(10);
    }
  });

  it('passes through limit === 0 only when used === 0 (zero quota = no calls)', async () => {
    const store = mkStore({
      alice: { used: 0, limit: 0, resetAt: future },
    });
    // 0 used >= 0 limit → exceeded (zero quota explicitly means "no calls")
    await expect(checkQuota({ userId: 'alice', store })).rejects.toThrow(
      QuotaExceededError,
    );
  });
});
