import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenError, TokenIssuer } from './tokens.js';

function mkIssuer(ttlMs?: number): TokenIssuer {
  const opts = ttlMs !== undefined
    ? { secret: randomBytes(32), defaultTtlMs: ttlMs }
    : { secret: randomBytes(32) };
  return new TokenIssuer(opts);
}

describe('TokenIssuer.constructor', () => {
  it('rejects secrets < 32 bytes', () => {
    expect(() => new TokenIssuer({ secret: randomBytes(16) })).toThrow(
      TokenError,
    );
  });
  it('accepts ≥32 byte secrets', () => {
    expect(() => new TokenIssuer({ secret: randomBytes(32) })).not.toThrow();
  });
});

describe('TokenIssuer.issue', () => {
  it('rejects empty userId', () => {
    const i = mkIssuer();
    expect(() => i.issue('')).toThrow(/non-empty/);
  });

  it('returns a parseable token with three dot-separated parts', () => {
    const i = mkIssuer();
    const r = i.issue('alice');
    expect(r.token.split('.').length).toBe(3);
    expect(r.token.startsWith('cca.')).toBe(true);
    expect(r.userId).toBe('alice');
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });

  it('two issues for same userId produce different tokens (nonce)', () => {
    const i = mkIssuer();
    const a = i.issue('alice');
    const b = i.issue('alice');
    expect(a.token).not.toBe(b.token);
  });

  it('honors per-call ttlMs override', () => {
    const i = mkIssuer(60_000);
    const r = i.issue('alice', 1000);
    expect(r.expiresAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('TokenIssuer.verify', () => {
  it('round-trips a fresh token', () => {
    const i = mkIssuer();
    const r = i.issue('alice');
    const v = i.verify(r.token);
    expect(v).not.toBeNull();
    expect(v?.userId).toBe('alice');
    expect(v?.expiresAt).toBe(r.expiresAt);
  });

  it('rejects expired tokens', () => {
    const i = mkIssuer(1); // 1ms TTL
    const r = i.issue('alice');
    // verify with now = expiresAt + 1ms → expired
    expect(i.verify(r.token, r.expiresAt + 1)).toBeNull();
  });

  it('rejects malformed tokens (wrong part count)', () => {
    const i = mkIssuer();
    expect(i.verify('not-a-token')).toBeNull();
    expect(i.verify('cca.only-two')).toBeNull();
    expect(i.verify('cca.a.b.c.d')).toBeNull();
  });

  it('rejects wrong prefix', () => {
    const i = mkIssuer();
    const r = i.issue('alice');
    const tampered = r.token.replace(/^cca\./, 'xxx.');
    expect(i.verify(tampered)).toBeNull();
  });

  it('rejects tampered payload (HMAC mismatch)', () => {
    const i = mkIssuer();
    const r = i.issue('alice');
    const parts = r.token.split('.');
    parts[1] = Buffer.from('{"uid":"mallory","exp":99999999999999,"nonce":"x"}').toString('base64url');
    expect(i.verify(parts.join('.'))).toBeNull();
  });

  it('rejects tokens signed by a different secret', () => {
    const a = mkIssuer();
    const b = mkIssuer();
    const t = a.issue('alice').token;
    expect(b.verify(t)).toBeNull();
  });

  it('rejects garbage base64', () => {
    const i = mkIssuer();
    expect(i.verify('cca.!!!.!!!')).toBeNull();
  });
});
