import { afterEach, describe, expect, it } from 'vitest';
import {
  hashBody,
  IDEMPOTENCY_KEY_PATTERN,
  IdempotencyStore,
  isValidIdempotencyKey,
} from './idempotency.js';

describe('hashBody (canonical)', () => {
  it('produces equal hashes for objects with same content but different key order', () => {
    expect(hashBody({ a: 1, b: 2 })).toBe(hashBody({ b: 2, a: 1 }));
  });

  it('produces different hashes for different content', () => {
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
  });

  it('handles nested objects deterministically', () => {
    expect(hashBody({ a: { x: 1, y: 2 } })).toBe(hashBody({ a: { y: 2, x: 1 } }));
  });

  it('treats arrays as ordered (different order = different hash)', () => {
    expect(hashBody([1, 2, 3])).not.toBe(hashBody([3, 2, 1]));
  });
});

describe('isValidIdempotencyKey', () => {
  it('accepts ASCII alphanumeric, dash, underscore', () => {
    expect(isValidIdempotencyKey('ABC-123_xyz')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(255))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidIdempotencyKey('')).toBe(false);
  });

  it('rejects too-long keys', () => {
    expect(isValidIdempotencyKey('a'.repeat(256))).toBe(false);
  });

  it('rejects non-ASCII / spaces / punctuation', () => {
    expect(isValidIdempotencyKey('hello world')).toBe(false);
    expect(isValidIdempotencyKey('包含中文')).toBe(false);
    expect(isValidIdempotencyKey('a/b')).toBe(false);
  });
});

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;

  afterEach(() => {
    store?.close();
  });

  it('miss → store → replay round trip', () => {
    store = new IdempotencyStore(60_000);
    const hash = hashBody({ projectId: 'demo', mode: 'create' });

    expect(store.lookup('s1', 'k1', hash)).toEqual({ kind: 'miss' });

    store.store('s1', 'k1', hash, 201, { id: 'sess-1' });
    const result = store.lookup('s1', 'k1', hash);
    expect(result.kind).toBe('replay');
    if (result.kind === 'replay') {
      expect(result.status).toBe(201);
      expect(result.body).toEqual({ id: 'sess-1' });
    }
  });

  it('returns conflict when same key but different body hash', () => {
    store = new IdempotencyStore(60_000);
    store.store('s1', 'k1', 'hash-a', 201, { id: 'a' });
    expect(store.lookup('s1', 'k1', 'hash-b')).toEqual({ kind: 'conflict' });
  });

  it('isolates scopes (e.g. different tokens)', () => {
    store = new IdempotencyStore(60_000);
    store.store('tokA', 'shared-key', 'h', 201, { id: 'a' });
    expect(store.lookup('tokB', 'shared-key', 'h')).toEqual({ kind: 'miss' });
  });

  it('expires entries past TTL (lazy on lookup)', async () => {
    store = new IdempotencyStore(50);
    store.store('s', 'k', 'h', 201, { id: 'x' });
    expect(store.lookup('s', 'k', 'h').kind).toBe('replay');
    await new Promise((r) => setTimeout(r, 80));
    expect(store.lookup('s', 'k', 'h').kind).toBe('miss');
  });

  it('does not cache 5xx responses', () => {
    store = new IdempotencyStore(60_000);
    store.store('s', 'k', 'h', 500, { error: 'boom' });
    expect(store.size()).toBe(0);
  });

  it('does not cache 1xx responses (only [200,500))', () => {
    store = new IdempotencyStore(60_000);
    store.store('s', 'k', 'h', 100, {});
    expect(store.size()).toBe(0);
  });

  it('caches 4xx (so client errors are stable on retry)', () => {
    store = new IdempotencyStore(60_000);
    store.store('s', 'k', 'h', 400, { error: 'invalid' });
    expect(store.lookup('s', 'k', 'h').kind).toBe('replay');
  });

  it('rejects non-positive ttl', () => {
    expect(() => new IdempotencyStore(0)).toThrow(RangeError);
    expect(() => new IdempotencyStore(-1)).toThrow(RangeError);
  });
});
