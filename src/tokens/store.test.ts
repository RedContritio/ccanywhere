import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenStore } from './store.js';

describe('TokenStore', () => {
  let dir: string;
  let statePath: string;
  let store: TokenStore;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccanywhere-tokenstore-'));
    statePath = join(dir, 'tokens.json');
    now = 1_000_000;
    store = new TokenStore({ statePath, now: () => now });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('issue', () => {
    it('issues a token with hashed storage; plaintext returned once', () => {
      const { token, plaintext } = store.issue({
        userId: 'u-1',
        ttlMs: 60_000,
        label: 'alice cli',
      });
      expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
      expect(token.userId).toBe('u-1');
      expect(token.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(token.tokenHash).not.toBe(plaintext);
      expect(token.expiresAt).toBe(now + 60_000);
      expect(token.status).toBe('active');
    });

    it('rejects ttl > 7d', () => {
      const eightDays = 8 * 24 * 60 * 60 * 1000;
      expect(() => store.issue({ userId: 'u-1', ttlMs: eightDays })).toThrow(
        /ttl out of range/,
      );
    });

    it('rejects ttl <= 0', () => {
      expect(() => store.issue({ userId: 'u-1', ttlMs: 0 })).toThrow(/ttl out of range/);
      expect(() => store.issue({ userId: 'u-1', ttlMs: -100 })).toThrow(/ttl out of range/);
    });
  });

  describe('verify', () => {
    it('returns the token when plaintext matches', () => {
      const { token, plaintext } = store.issue({ userId: 'u-1', ttlMs: 60_000 });
      expect(store.verify(plaintext)?.id).toBe(token.id);
    });

    it('returns null for wrong plaintext', () => {
      store.issue({ userId: 'u-1', ttlMs: 60_000 });
      expect(store.verify('00'.repeat(32))).toBeNull();
    });

    it('returns null after revoke', () => {
      const { token, plaintext } = store.issue({ userId: 'u-1', ttlMs: 60_000 });
      store.revoke(token.id);
      expect(store.verify(plaintext)).toBeNull();
    });

    it('returns null past expiresAt', () => {
      const { plaintext } = store.issue({ userId: 'u-1', ttlMs: 60_000 });
      now += 60_001;
      expect(store.verify(plaintext)).toBeNull();
    });
  });

  describe('list', () => {
    it('filters by userId', () => {
      store.issue({ userId: 'u-1', ttlMs: 60_000, label: 'a' });
      store.issue({ userId: 'u-2', ttlMs: 60_000, label: 'b' });
      store.issue({ userId: 'u-1', ttlMs: 60_000, label: 'c' });
      expect(store.list('u-1')).toHaveLength(2);
      expect(store.list('u-2')).toHaveLength(1);
      expect(store.list()).toHaveLength(3);
    });
  });

  describe('persistence', () => {
    it('reloads tokens across construction', () => {
      const { token } = store.issue({ userId: 'u-1', ttlMs: 60_000 });
      const fresh = new TokenStore({ statePath, now: () => now });
      expect(fresh.findById(token.id)?.tokenHash).toBe(token.tokenHash);
    });
  });
});
