/**
 * inline quota enforcement — called before each upstream forward. Owner
 * path never reaches here (D7: owner bypasses the proxy entirely), so
 * "unknown user" is fail-closed, not fail-open.
 */

export class QuotaExceededError extends Error {
  constructor(
    public readonly userId: string,
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`user ${userId} quota exceeded (${used}/${limit})`);
    this.name = 'QuotaExceededError';
  }
}

export class UnknownUserError extends Error {
  constructor(public readonly userId: string) {
    super(`unknown user ${userId}`);
    this.name = 'UnknownUserError';
  }
}

export interface UsageState {
  /** Current period usage in the same unit as `limit`. */
  readonly used: number;
  /** `null` = unlimited (admin override only; user-facing default is finite). */
  readonly limit: number | null;
  /** Unix ms when this period resets and `used` returns to 0. */
  readonly resetAt: number;
}

export interface UsageStore {
  /**
   * Look up the current usage record for `userId`. `null` ⇒ user not
   * enrolled in metering (the proxy MUST reject with UnknownUserError
   * rather than allow through). C3 will provide a real file-backed
   * implementation; C2 ships only the interface so tests can mock.
   */
  getUsage(userId: string): Promise<UsageState | null>;
}

export interface CheckQuotaOpts {
  readonly userId: string;
  readonly store: UsageStore;
}

export async function checkQuota(opts: CheckQuotaOpts): Promise<void> {
  const state = await opts.store.getUsage(opts.userId);
  if (state === null) {
    throw new UnknownUserError(opts.userId);
  }
  if (state.limit === null) return; // unlimited
  if (state.used >= state.limit) {
    throw new QuotaExceededError(opts.userId, state.used, state.limit);
  }
}
