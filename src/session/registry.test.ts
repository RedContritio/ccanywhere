import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRegistry } from './registry.js';
import type { SessionInfo } from './types.js';

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: overrides.id ?? 'sess-1',
    projectId: overrides.projectId ?? 'proj-1',
    cwd: overrides.cwd ?? '/tmp/proj-1',
    mode: overrides.mode ?? 'create',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    userId: overrides.userId ?? 'user-1',
    ...(overrides.resumeSessionId !== undefined
      ? { resumeSessionId: overrides.resumeSessionId }
      : {}),
  };
}

describe('SessionRegistry', () => {
  let dir: string;
  let registry: SessionRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-registry-'));
    registry = new SessionRegistry(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save then loadAllSync round-trips an active session', async () => {
    await registry.save(info({ id: 'a' }), null);

    const all = registry.loadAllSync();
    expect(all).toHaveLength(1);
    const persisted = all[0]!;
    expect(persisted.info.id).toBe('a');
    expect(persisted.info.projectId).toBe('proj-1');
    expect(persisted.deletedAt).toBeNull();
    expect(persisted.lastScreen).toBe('');
  });

  it('save + saveScreen round-trips both', async () => {
    await registry.save(info({ id: 'b' }), null);
    await registry.saveScreen('b', 'last frame text\nrow 2');

    const all = registry.loadAllSync();
    expect(all).toHaveLength(1);
    expect(all[0]!.lastScreen).toBe('last frame text\nrow 2');
  });

  it('persists deletedAt for soft-deleted sessions', async () => {
    await registry.save(info({ id: 'c' }), 1_700_000_500_000);
    const [persisted] = registry.loadAllSync();
    expect(persisted!.deletedAt).toBe(1_700_000_500_000);
  });

  it('preserves resumeSessionId field across roundtrip', async () => {
    await registry.save(
      info({ id: 'd', mode: 'resume', resumeSessionId: 'cc-orig-123' }),
      null,
    );
    const [persisted] = registry.loadAllSync();
    expect(persisted!.info.mode).toBe('resume');
    expect(persisted!.info.resumeSessionId).toBe('cc-orig-123');
  });

  it('delete removes both metadata and screen file', async () => {
    await registry.save(info({ id: 'e' }), null);
    await registry.saveScreen('e', 'X');
    expect(existsSync(join(dir, 'e.json'))).toBe(true);
    expect(existsSync(join(dir, 'e.screen.txt'))).toBe(true);

    await registry.delete('e');

    expect(existsSync(join(dir, 'e.json'))).toBe(false);
    expect(existsSync(join(dir, 'e.screen.txt'))).toBe(false);
  });

  it('delete is idempotent on missing files', async () => {
    await expect(registry.delete('never-existed')).resolves.toBeUndefined();
  });

  it('deleteScreen drops only the screen file', async () => {
    await registry.save(info({ id: 'f' }), null);
    await registry.saveScreen('f', 'X');

    await registry.deleteScreen('f');

    expect(existsSync(join(dir, 'f.json'))).toBe(true);
    expect(existsSync(join(dir, 'f.screen.txt'))).toBe(false);
  });

  it('loadAllSync skips corrupt json and continues', async () => {
    await registry.save(info({ id: 'good' }), null);
    writeFileSync(join(dir, 'bad.json'), '{not valid json');

    const all = registry.loadAllSync();
    expect(all.map((p) => p.info.id)).toEqual(['good']);
  });

  it('loadAllSync skips entries with malformed required fields', async () => {
    await registry.save(info({ id: 'good' }), null);
    writeFileSync(
      join(dir, 'bad-shape.json'),
      JSON.stringify({ id: 'bad', projectId: 'x' }),
    );

    const all = registry.loadAllSync();
    expect(all.map((p) => p.info.id)).toEqual(['good']);
  });

  it('loadAllSync ignores non-json + hidden files', async () => {
    await registry.save(info({ id: 'good' }), null);
    writeFileSync(join(dir, 'README'), 'not json');
    writeFileSync(join(dir, '.DS_Store'), 'mac junk');
    writeFileSync(join(dir, '.hidden.json'), JSON.stringify(info()));

    const all = registry.loadAllSync();
    expect(all.map((p) => p.info.id)).toEqual(['good']);
  });

  it('loadAllSync auto-creates missing dir and returns empty', async () => {
    const missing = join(dir, 'nope');
    const r = new SessionRegistry(missing);
    expect(existsSync(missing)).toBe(true);
    expect(r.loadAllSync()).toEqual([]);
  });

  it('concurrent saves do not corrupt each other', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
    await Promise.all(ids.map((id) => registry.save(info({ id }), null)));

    const all = registry.loadAllSync();
    expect(all.map((p) => p.info.id).sort()).toEqual(ids);
  });

  it('overwrites existing metadata on re-save', async () => {
    await registry.save(info({ id: 'g' }), null);
    await registry.save(info({ id: 'g' }), 1_700_000_900_000);

    const [persisted] = registry.loadAllSync();
    expect(persisted!.deletedAt).toBe(1_700_000_900_000);
  });

  it('survives screen file missing when metadata exists', async () => {
    await registry.save(info({ id: 'h' }), null);
    // No saveScreen call — represents a session that was mid-running
    // when shutdown hit before onExit fired.

    const [persisted] = registry.loadAllSync();
    expect(persisted!.info.id).toBe('h');
    expect(persisted!.lastScreen).toBe('');
  });

  // Regression: two concurrent writes to the same <id>.json used to be
  // able to interleave truncate + partial write, corrupting the file.
  // Per-id chain in registry now serializes them — final state MUST be a
  // valid JSON matching the last issued payload, never a parse error.
  it('serializes concurrent writes to the same id (regression: write-queue ordering)', async () => {
    const id = 'race';
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(registry.save(info({ id }), i));
    }
    await Promise.all(promises);

    const all = registry.loadAllSync();
    expect(all).toHaveLength(1);
    expect(all[0]!.info.id).toBe(id);
    expect(all[0]!.deletedAt).toBe(99);
  });
});
