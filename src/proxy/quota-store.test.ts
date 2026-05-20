import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileUsageStore, nextDailyReset } from './quota-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccanywhere-usage-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mkStore(
  limits: Record<string, number | null | undefined>,
  now?: () => number,
): FileUsageStore {
  const opts: ConstructorParameters<typeof FileUsageStore>[0] = {
    statePath: join(dir, 'proxy-usage.json'),
    limitOf: (id) => limits[id],
  };
  if (now !== undefined) {
    (opts as { now?: () => number }).now = now;
  }
  return new FileUsageStore(opts);
}

describe('nextDailyReset', () => {
  it('returns the next UTC midnight strictly after now', () => {
    // 2026-05-17 14:30:00 UTC
    const now = Date.UTC(2026, 4, 17, 14, 30, 0);
    const next = nextDailyReset(now);
    // 2026-05-18 00:00:00 UTC
    expect(next).toBe(Date.UTC(2026, 4, 18, 0, 0, 0));
  });

  it('rolls forward when called exactly at UTC midnight', () => {
    const midnight = Date.UTC(2026, 4, 17, 0, 0, 0);
    expect(nextDailyReset(midnight)).toBe(Date.UTC(2026, 4, 18, 0, 0, 0));
  });
});

describe('FileUsageStore.getUsage', () => {
  it('returns null for unknown user (limitOf returns undefined)', async () => {
    const store = mkStore({});
    expect(await store.getUsage('ghost')).toBeNull();
  });

  it('returns used=0 for known user with no prior records', async () => {
    const store = mkStore({ alice: 10 });
    const u = await store.getUsage('alice');
    expect(u?.used).toBe(0);
    expect(u?.limit).toBe(10);
  });

  it('returns null limit (unlimited) when limitOf returns null', async () => {
    const store = mkStore({ admin: null });
    const u = await store.getUsage('admin');
    expect(u?.limit).toBeNull();
  });

  it('returns accumulated usage', async () => {
    const store = mkStore({ alice: 10 });
    await store.addUsage('alice', 0.5);
    await store.addUsage('alice', 1.2);
    const u = await store.getUsage('alice');
    expect(u?.used).toBeCloseTo(1.7);
  });

  it('lazy-resets on period boundary', async () => {
    let now = Date.UTC(2026, 4, 17, 10, 0, 0);
    const store = mkStore({ alice: 10 }, () => now);
    await store.addUsage('alice', 2);
    expect((await store.getUsage('alice'))?.used).toBe(2);

    // jump to next day
    now = Date.UTC(2026, 4, 18, 1, 0, 0);
    expect((await store.getUsage('alice'))?.used).toBe(0);
  });

  it('limit is live (re-read from limitOf, not cached)', async () => {
    const limits: Record<string, number | null | undefined> = { alice: 10 };
    const store = new FileUsageStore({
      statePath: join(dir, 'usage.json'),
      limitOf: (id) => limits[id],
    });
    await store.addUsage('alice', 1);
    limits['alice'] = 20; // admin bumps limit
    expect((await store.getUsage('alice'))?.limit).toBe(20);
  });
});

describe('FileUsageStore.addUsage', () => {
  it('rejects negative costUsd', async () => {
    const store = mkStore({ alice: 10 });
    await expect(store.addUsage('alice', -1)).rejects.toThrow(RangeError);
  });

  it('persists to disk with mode 0600', async () => {
    const store = mkStore({ alice: 10 });
    await store.addUsage('alice', 0.5);
    const p = join(dir, 'proxy-usage.json');
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(p, 'utf8')) as Record<
      string,
      { used: number; resetAt: number }
    >;
    expect(persisted['alice']?.used).toBe(0.5);
  });

  it('survives proxy restart (new instance reads same file)', async () => {
    const path = join(dir, 'proxy-usage.json');
    const limitOf = (id: string) =>
      ({ alice: 10 } as Record<string, number>)[id];
    const s1 = new FileUsageStore({ statePath: path, limitOf });
    await s1.addUsage('alice', 3.14);
    const s2 = new FileUsageStore({ statePath: path, limitOf });
    expect((await s2.getUsage('alice'))?.used).toBeCloseTo(3.14);
  });

  it('starts from 0 if state file is corrupt', async () => {
    const path = join(dir, 'proxy-usage.json');
    // pre-populate garbage
    const limitOf = () => 10;
    writeFileSync(path, 'not json');
    const store = new FileUsageStore({ statePath: path, limitOf });
    expect((await store.getUsage('alice'))?.used).toBe(0);
  });
});
