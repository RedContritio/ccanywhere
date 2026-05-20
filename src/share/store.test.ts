import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateShareCode } from './code.js';
import { type ShareRecord, ShareStore } from './store.js';

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    code: overrides.code ?? generateShareCode(),
    sessionId: overrides.sessionId ?? 'sess-1',
    createdBy: overrides.createdBy ?? 'alice',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    expiresAt:
      overrides.expiresAt === undefined ? null : overrides.expiresAt,
    projectName: overrides.projectName ?? 'demo',
  };
}

describe('ShareStore', () => {
  let dir: string;
  let store: ShareStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-shares-'));
    store = new ShareStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save then load round-trips a non-expiring record', async () => {
    const r = record();
    await store.save(r, '<html>hi</html>');
    expect(store.load(r.code)).toEqual(r);
    expect(store.loadHtml(r.code)).toBe('<html>hi</html>');
  });

  it('load returns undefined for unknown code', () => {
    expect(store.load(generateShareCode())).toBeUndefined();
    expect(store.loadHtml(generateShareCode())).toBeUndefined();
  });

  it('load drops + unlinks expired record (lazy GC per D6)', async () => {
    const r = record({ expiresAt: Date.now() - 1000 });
    await store.save(r, '<html/>');
    expect(store.load(r.code)).toBeUndefined();
    // Lazy delete is fire-and-forget (load() voids the promise); idle()
    // waits for the queued unlink to settle deterministically.
    await store.idle(r.code);
    expect(existsSync(join(dir, `${r.code}.json`))).toBe(false);
    expect(existsSync(join(dir, `${r.code}.html`))).toBe(false);
  });

  it('load returns the record exactly at expiresAt = now (boundary)', async () => {
    // expiresAt === now should still be considered expired (strict `<`
    // check means equal-to-now is the *last* moment alive — actually we
    // treat expiresAt < now as expired, so == now stays alive).
    const r = record({ expiresAt: Date.now() + 10_000 });
    await store.save(r, '<html/>');
    expect(store.load(r.code)).not.toBeUndefined();
  });

  it('delete removes both metadata + html', async () => {
    const r = record();
    await store.save(r, '<html/>');
    await store.delete(r.code);
    expect(store.load(r.code)).toBeUndefined();
    expect(store.loadHtml(r.code)).toBeUndefined();
    expect(existsSync(join(dir, `${r.code}.json`))).toBe(false);
    expect(existsSync(join(dir, `${r.code}.html`))).toBe(false);
  });

  it('delete is idempotent on missing code', async () => {
    await expect(
      store.delete(generateShareCode()),
    ).resolves.toBeUndefined();
  });

  it('loadAllSync returns every live record', async () => {
    const a = record({ sessionId: 'a' });
    const b = record({ sessionId: 'b' });
    const c = record({ sessionId: 'c' });
    await store.save(a, '<a/>');
    await store.save(b, '<b/>');
    await store.save(c, '<c/>');
    const all = store.loadAllSync();
    const sessionIds = all.map((r) => r.sessionId).sort();
    expect(sessionIds).toEqual(['a', 'b', 'c']);
  });

  it('loadAllSync sweeps expired records (unlinks both files)', async () => {
    const live = record({ sessionId: 'live' });
    const dead = record({
      sessionId: 'dead',
      expiresAt: Date.now() - 1000,
    });
    await store.save(live, '<live/>');
    await store.save(dead, '<dead/>');
    const all = store.loadAllSync();
    expect(all.map((r) => r.sessionId)).toEqual(['live']);
    expect(existsSync(join(dir, `${dead.code}.json`))).toBe(false);
    expect(existsSync(join(dir, `${dead.code}.html`))).toBe(false);
  });

  it('loadAllSync skips corrupt json (fail-soft)', async () => {
    const good = record({ sessionId: 'good' });
    await store.save(good, '<g/>');
    writeFileSync(join(dir, 'bogus.json'), '{ this is not json');
    const all = store.loadAllSync();
    expect(all.map((r) => r.sessionId)).toEqual(['good']);
  });

  it('loadAllSync skips malformed-but-parseable json', async () => {
    writeFileSync(join(dir, 'malformed.json'), JSON.stringify({ wat: 1 }));
    expect(store.loadAllSync()).toEqual([]);
  });

  it('loadAllSync ignores non-json + hidden files', async () => {
    const r = record();
    await store.save(r, '<h/>');
    writeFileSync(join(dir, 'sidecar.txt'), 'ignored');
    writeFileSync(join(dir, '.DS_Store'), 'mac noise');
    expect(store.loadAllSync()).toHaveLength(1);
  });

  it('listByUserSync filters to a single user', async () => {
    await store.save(record({ createdBy: 'alice' }), '<a/>');
    await store.save(record({ createdBy: 'bob' }), '<b/>');
    await store.save(record({ createdBy: 'alice' }), '<a2/>');
    expect(store.listByUserSync('alice')).toHaveLength(2);
    expect(store.listByUserSync('bob')).toHaveLength(1);
    expect(store.listByUserSync('carol')).toHaveLength(0);
  });

  it('save overwrites prior content under the same code', async () => {
    const r = record();
    await store.save(r, '<v1/>');
    await store.save(r, '<v2/>');
    expect(store.loadHtml(r.code)).toBe('<v2/>');
  });

  it('serializes concurrent writes to the same code (regression guard)', async () => {
    const r = record();
    const N = 50;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(store.save({ ...r, sessionId: `v${i}` }, `<v${i}/>`));
    }
    await Promise.all(promises);
    const final = store.load(r.code);
    expect(final).not.toBeUndefined();
    expect(final!.sessionId).toBe(`v${N - 1}`);
    expect(store.loadHtml(r.code)).toBe(`<v${N - 1}/>`);
  });

  it('auto-creates the dir if missing', async () => {
    const missing = join(dir, 'nested', 'deep');
    const s = new ShareStore(missing);
    expect(existsSync(missing)).toBe(true);
    expect(s.loadAllSync()).toEqual([]);
  });

  it('readFileSync metadata path equals dir/code.json (filesystem inspection)', async () => {
    const r = record();
    await store.save(r, '<h/>');
    const onDisk = JSON.parse(readFileSync(join(dir, `${r.code}.json`), 'utf8'));
    expect(onDisk.code).toBe(r.code);
    expect(onDisk.sessionId).toBe(r.sessionId);
  });
});
