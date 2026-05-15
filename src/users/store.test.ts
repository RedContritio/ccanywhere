import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserStore } from './store.js';
import type { ToolbarLayout } from './types.js';

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
      workspace: guestRoot,
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
        workspace: guestRoot,
        now: () => now,
      });
      expect(fresh.list()).toHaveLength(1);
      expect(fresh.getOwner().id).toBe(id);
    });
  });

  describe('createUser', () => {
    it('creates user + mkdirs guest dir', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      expect(u.kind).toBe('user');
      expect(u.quota.cost.limitUsd).toBe(5);
      expect(u.quota.tokens.limit).toBeNull();
      expect(existsSync(join(guestRoot, 'alice'))).toBe(true);
    });

    it('rejects when username already taken', () => {
      store.createUser({ username: 'alice', costLimitUsd: 5, tokensLimit: null });
      expect(() =>
        store.createUser({ username: 'alice', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow(/already exists/);
    });

    it('rejects when guest dir already on disk (fs guard)', () => {
      mkdirSync(join(guestRoot, 'preexist'), { mode: 0o700 });
      expect(() =>
        store.createUser({
          username: 'preexist',
          costLimitUsd: 5,
          tokensLimit: null,
        }),
      ).toThrow(/fs guard/);
    });

    it('rejects when both quota limits are null', () => {
      expect(() =>
        store.createUser({
          username: 'alice',
          costLimitUsd: null,
          tokensLimit: null,
        }),
      ).toThrow(/at least one quota limit/);
    });

    it('rejects bad username (special char / empty)', () => {
      expect(() =>
        store.createUser({ username: 'has@symbol', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow(/invalid username/);
      expect(() =>
        store.createUser({ username: '', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow(/invalid username/);
    });

    it('accepts ASCII / CJK / underscore / space within length', () => {
      store.createUser({ username: 'alice_42', costLimitUsd: 5, tokensLimit: null });
      store.createUser({ username: '李四', costLimitUsd: 5, tokensLimit: null });
      store.createUser({ username: 'one two', costLimitUsd: 5, tokensLimit: null });
      expect(store.list().filter((u) => u.kind === 'user')).toHaveLength(3);
    });

    it('NFC-normalizes username — NFD input stored as NFC', () => {
      const nfd = 'café'; // composed: e + combining acute
      const nfc = nfd.normalize('NFC');
      expect(nfd).not.toBe(nfc); // distinct code-point sequences
      const u = store.createUser({
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
        store.createUser({ username: 'bob', costLimitUsd: 5, tokensLimit: null }),
      ).toThrow();
      expect(existsSync(join(guestRoot, 'bob'))).toBe(false);
      expect(store.findByUsername('bob')).toBeNull();
    });

    it('persists across reload', () => {
      const a = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      const fresh = new UserStore({
        statePath,
        workspace: guestRoot,
        now: () => now,
      });
      expect(fresh.findById(a.id)?.username).toBe('alice');
    });
  });

  describe('setQuotaLimit', () => {
    it('topup cost limit', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      const updated = store.setQuotaLimit(u.id, { costLimitUsd: 10 });
      expect(updated.quota.cost.limitUsd).toBe(10);
    });

    it('clearing one limit while keeping another is OK', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: 1000,
      });
      const updated = store.setQuotaLimit(u.id, { costLimitUsd: null });
      expect(updated.quota.cost.limitUsd).toBeNull();
      expect(updated.quota.tokens.limit).toBe(1000);
    });

    it('rejects when both end up null', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      expect(() => store.setQuotaLimit(u.id, { costLimitUsd: null })).toThrow(
        /at least one quota limit/,
      );
    });

    it('reset zeros usedUsd and used', () => {
      const u = store.createUser({
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

  describe('preferences (m-user-prefs)', () => {
    it('fresh user has empty preferences object', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      expect(u.preferences).toEqual({});
      expect(u.lastActiveSessionId).toBeNull();
    });

    it('owner bootstrap creates with empty prefs + null lastActiveSessionId', () => {
      const owner = store.getOwner();
      expect(owner.preferences).toEqual({});
      expect(owner.lastActiveSessionId).toBeNull();
    });

    it('getPreferences returns null for unknown user', () => {
      expect(store.getPreferences('does-not-exist')).toBeNull();
    });

    it('setPreferences + getPreferences roundtrip', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      const layout: ToolbarLayout = {
        rows: 2,
        cols: 3,
        cells: [
          { id: 'esc', label: 'Esc', action: 'plain', payload: '\x1b' },
          { id: 'tab', label: 'Tab', action: 'plain', payload: '\t' },
          null,
          { id: 'ctrl', label: 'Ctrl', action: 'toggle-sticky-ctrl', payload: '' },
          { id: 'c', label: '^C', action: 'ctrl-letter', payload: 'c' },
          null,
        ],
      };
      store.setPreferences(u.id, { toolbar: layout });
      const got = store.getPreferences(u.id);
      expect(got?.toolbar).toEqual(layout);
    });

    it('setLastActiveSession + roundtrip', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      const sid = '11111111-2222-3333-4444-555555555555';
      const next = store.setLastActiveSession(u.id, sid);
      expect(next.lastActiveSessionId).toBe(sid);
      expect(store.findById(u.id)?.lastActiveSessionId).toBe(sid);
      const cleared = store.setLastActiveSession(u.id, null);
      expect(cleared.lastActiveSessionId).toBeNull();
    });

    it("legacy users.json with kind='limited' migrates to 'user' on load + persists (m-user-symmetric)", () => {
      const legacyPath = join(configDir, 'legacy-kind.json');
      const aliceId = '00000000-0000-4000-8000-000000000099';
      writeFileSync(
        legacyPath,
        JSON.stringify({
          users: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              username: 'owner',
              kind: 'owner',
              createdAt: 1,
              lastLoginAt: null,
              quota: {
                cost: { limitUsd: null, usedUsd: 0 },
                tokens: { limit: null, used: 0 },
              },
              preferences: {},
              lastActiveSessionId: null,
            },
            {
              id: aliceId,
              username: 'alice',
              kind: 'limited',
              createdAt: 2,
              lastLoginAt: null,
              quota: {
                cost: { limitUsd: 5, usedUsd: 0 },
                tokens: { limit: null, used: 0 },
              },
              preferences: {},
              lastActiveSessionId: null,
            },
          ],
        }),
      );
      const legacyStore = new UserStore({
        statePath: legacyPath,
        workspace: guestRoot,
        now: () => now,
      });
      const alice = legacyStore.findById(aliceId);
      expect(alice?.kind).toBe('user');
      // file persisted with new kind value
      const raw = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
        users: Array<{ id: string; kind: string }>;
      };
      const aliceRaw = raw.users.find((u) => u.id === aliceId);
      expect(aliceRaw?.kind).toBe('user');
    });

    it('legacy users.json (no preferences / lastActiveSessionId fields) migrates to defaults on load', () => {
      // Build a legacy file by hand.
      const legacyPath = join(configDir, 'legacy.json');
      const ownerId = '00000000-0000-4000-8000-000000000001';
      writeFileSync(
        legacyPath,
        JSON.stringify({
          users: [
            {
              id: ownerId,
              username: 'owner',
              kind: 'owner',
              createdAt: 1,
              lastLoginAt: null,
              quota: {
                cost: { limitUsd: null, usedUsd: 0 },
                tokens: { limit: null, used: 0 },
              },
              // preferences + lastActiveSessionId intentionally missing
            },
          ],
        }),
      );
      const legacyStore = new UserStore({
        statePath: legacyPath,
        workspace: guestRoot,
        now: () => now,
      });
      const owner = legacyStore.findById(ownerId);
      expect(owner?.preferences).toEqual({});
      expect(owner?.lastActiveSessionId).toBeNull();
    });

    it('persisted users.json contains preferences + lastActiveSessionId after writes', () => {
      const u = store.createUser({
        username: 'alice',
        costLimitUsd: 5,
        tokensLimit: null,
      });
      store.setPreferences(u.id, {
        toolbar: { rows: 1, cols: 3, cells: [null, null, null] },
      });
      store.setLastActiveSession(u.id, 'sid-abc');
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as {
        users: Array<{ preferences?: object; lastActiveSessionId?: string | null }>;
      };
      const alice = raw.users.find((rec) => rec.lastActiveSessionId === 'sid-abc');
      expect(alice?.preferences).toBeDefined();
      expect(alice?.lastActiveSessionId).toBe('sid-abc');
    });
  });
});
