import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserStore } from './store.js';

describe('UserStore', () => {
  let configDir: string;
  let guestRoot: string;
  let statePath: string;
  let store: UserStore;
  let now: number;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'ccanywhere-userstore-'));
    guestRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-guest-'));
    statePath = join(configDir, 'users.json');
    now = 1_000_000;
    store = new UserStore({
      statePath,
      guestProjectsRoot: guestRoot,
      now: () => now,
    });
  });

  afterEach(() => {
    try {
      chmodSync(statePath, 0o600);
    } catch {
      // ignore
    }
    rmSync(configDir, { recursive: true, force: true });
    rmSync(guestRoot, { recursive: true, force: true });
  });

  describe('owner bootstrap', () => {
    it('first init auto-creates the owner with null quota limits', () => {
      const owner = store.getOwner();
      expect(owner.username).toBe('owner');
      expect(owner.kind).toBe('owner');
      expect(owner.quota.cost.limitUsd).toBeNull();
      expect(owner.quota.tokens.limit).toBeNull();
      expect(owner.quota.cost.usedUsd).toBe(0);
      expect(owner.quota.tokens.used).toBe(0);
    });

    it('reload does not duplicate the owner', () => {
      const id = store.getOwner().id;
      const fresh = new UserStore({
        statePath,
        guestProjectsRoot: guestRoot,
        now: () => now,
      });
      expect(fresh.list()).toHaveLength(1);
      expect(fresh.getOwner().id).toBe(id);
    });
  });

  describe('createLimitedUser', () => {
    it('creates user + mkdirs guest dir', () => {
      const u = store.createLimitedUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      expect(u.kind).toBe('limited');
      expect(u.quota.cost.limitUsd).toBe(5);
      expect(u.quota.tokens.limit).toBeNull();
      expect(existsSync(join(guestRoot, 'alice'))).toBe(true);
    });

    it('rejects when username already taken', () => {
      store.createLimitedUser({ username: 'alice', costLimitUsd: 5, tokensLimit: null });
      expect(() =>
        store.createLimitedUser({ username: 'alice', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow(/already exists/);
    });

    it('rejects when guest dir already on disk (fs guard)', () => {
      mkdirSync(join(guestRoot, 'preexist'), { mode: 0o700 });
      expect(() =>
        store.createLimitedUser({
          username: 'preexist',
          costLimitUsd: 5,
          tokensLimit: null,
        }),
      ).toThrow(/fs guard/);
    });

    it('rejects when both quota limits are null', () => {
      expect(() =>
        store.createLimitedUser({
          username: 'alice',
          costLimitUsd: null,
          tokensLimit: null,
        }),
      ).toThrow(/at least one quota limit/);
    });

    it('rejects bad username (special char / empty)', () => {
      expect(() =>
        store.createLimitedUser({ username: 'has@symbol', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow(/invalid username/);
      expect(() =>
        store.createLimitedUser({ username: '', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow(/invalid username/);
    });

    it('accepts ASCII / CJK / underscore / space within length', () => {
      store.createLimitedUser({ username: 'alice_42', costLimitUsd: 5, tokensLimit: null });
      store.createLimitedUser({ username: '李四', costLimitUsd: 5, tokensLimit: null });
      store.createLimitedUser({ username: 'one two', costLimitUsd: 5, tokensLimit: null });
      expect(store.list().filter((u) => u.kind === 'limited')).toHaveLength(3);
    });

    it('NFC-normalizes username — NFD input stored as NFC', () => {
      const nfd = 'café'; // composed: e + combining acute
      const nfc = nfd.normalize('NFC');
      expect(nfd).not.toBe(nfc); // distinct code-point sequences
      const u = store.createLimitedUser({
        username: nfd,
        costLimitUsd: 5,
        tokensLimit: null,
      });
      expect(u.username).toBe(nfc);
      expect(store.findByUsername(nfd)?.id).toBe(u.id);
      expect(store.findByUsername(nfc)?.id).toBe(u.id);
    });

    it('rolls back mkdir when persist fails', () => {
      chmodSync(statePath, 0o400);
      expect(() =>
        store.createLimitedUser({ username: 'bob', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow();
      expect(existsSync(join(guestRoot, 'bob'))).toBe(false);
      expect(store.findByUsername('bob')).toBeNull();
    });

    it('persists across reload', () => {
      const a = store.createLimitedUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      const fresh = new UserStore({
        statePath,
        guestProjectsRoot: guestRoot,
        now: () => now,
      });
      expect(fresh.findById(a.id)?.username).toBe('alice');
    });
  });

  describe('setQuotaLimit', () => {
    it('topup cost limit', () => {
      const u = store.createLimitedUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      const updated = store.setQuotaLimit(u.id, { costLimitUsd: 10 });
      expect(updated.quota.cost.limitUsd).toBe(10);
    });

    it('clearing one limit while keeping another is OK', () => {
      const u = store.createLimitedUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: 1000,
      });
      const updated = store.setQuotaLimit(u.id, { costLimitUsd: null });
      expect(updated.quota.cost.limitUsd).toBeNull();
      expect(updated.quota.tokens.limit).toBe(1000);
    });

    it('rejects when both end up null', () => {
      const u = store.createLimitedUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      expect(() => store.setQuotaLimit(u.id, { costLimitUsd: null })).toThrow(
        /at least one quota limit/,
      );
    });

    it('reset zeros usedUsd and used', () => {
      const u = store.createLimitedUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: 1000,
      });
      store.setQuotaUsage(u.id, 3.5, 500);
      expect(store.findById(u.id)?.quota.cost.usedUsd).toBe(3.5);
      const after = store.setQuotaLimit(u.id, { reset: true });
      expect(after.quota.cost.usedUsd).toBe(0);
      expect(after.quota.tokens.used).toBe(0);
    });

    it('rejects setQuotaLimit on owner', () => {
      const owner = store.getOwner();
      expect(() => store.setQuotaLimit(owner.id, { costLimitUsd: 5 })).toThrow(/owner/);
    });
  });
});
