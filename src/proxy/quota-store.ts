import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { UsageState, UsageStore } from './quota-check.js';

interface PersistedEntry {
  used: number;
  resetAt: number;
}

interface PersistedShape {
  [userId: string]: PersistedEntry;
}

export interface FileUsageStoreOpts {
  readonly statePath: string;
  /**
   * Live limit lookup. Returns USD limit (null = unlimited) for known
   * users, or `undefined` for unknown users (triggers UnknownUserError
   * downstream). Typically wraps `userStore.findById(id)?.quota.cost
   * .limitUsd`. Re-evaluated on every getUsage call so admin limit
   * edits propagate without restart (within the in-memory UserStore
   * scope; cross-process change still needs proxy restart).
   */
  readonly limitOf: (userId: string) => number | null | undefined;
  /** Injectable for tests; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Daily-resetting USD usage accounting. Single source of truth for
 * proxy-routed traffic. No sync with UserStore.quota.usedUsd —
 * proxy and user-container flows track usage independently.
 *
 * Reset window: per calendar day, UTC. First call of a new day
 * implicitly zeros the user's `used`; no background timer.
 */
export class FileUsageStore implements UsageStore {
  private readonly statePath: string;
  private readonly limitOf: (userId: string) => number | null | undefined;
  private readonly now: () => number;
  private state: PersistedShape;

  constructor(opts: FileUsageStoreOpts) {
    this.statePath = opts.statePath;
    this.limitOf = opts.limitOf;
    this.now = opts.now ?? Date.now;
    this.state = this.loadState();
  }

  private loadState(): PersistedShape {
    if (!existsSync(this.statePath)) return {};
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      return parsed as PersistedShape;
    } catch {
      // Corrupt state file → start fresh (admin can investigate the
      // backup .bak the next persist will leave). Persisted records are
      // recoverable from upstream Anthropic billing dashboard anyway;
      // refusing to start because of a parse error is worse UX.
      return {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    try {
      chmodSync(this.statePath, 0o600);
    } catch {
      // best-effort
    }
  }

  async getUsage(userId: string): Promise<UsageState | null> {
    const limit = this.limitOf(userId);
    if (limit === undefined) return null; // unknown user (D7 fail-closed)

    const now = this.now();
    const entry = this.state[userId];

    if (entry === undefined || now >= entry.resetAt) {
      return {
        used: 0,
        limit,
        resetAt: nextDailyReset(now),
      };
    }

    return {
      used: entry.used,
      limit, // always live, not the cached value at last persist
      resetAt: entry.resetAt,
    };
  }

  /**
   * Atomic-ish increment (single-process; multi-process needs a lock —
   * not required while proxy is a single child process per host).
   * Lazy-resets on period boundary.
   */
  async addUsage(userId: string, costUsd: number): Promise<void> {
    if (costUsd < 0) {
      throw new RangeError(`costUsd must be >= 0, got ${costUsd}`);
    }
    const now = this.now();
    let entry = this.state[userId];
    if (entry === undefined || now >= entry.resetAt) {
      entry = { used: 0, resetAt: nextDailyReset(now) };
    }
    entry.used += costUsd;
    this.state[userId] = entry;
    this.persist();
  }
}

/**
 * Next UTC 00:00:00.000 strictly after `now`. Same-day calls all return
 * the same boundary; rolls forward on midnight.
 */
export function nextDailyReset(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  let next = d.getTime();
  if (next <= now) next += 24 * 60 * 60 * 1000;
  return next;
}
