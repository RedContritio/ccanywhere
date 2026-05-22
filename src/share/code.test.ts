import { describe, expect, it } from 'vitest';

import { generateShareCode, isValidShareCode } from './code.js';

describe('generateShareCode', () => {
  it('returns UUID v4 format', () => {
    const c = generateShareCode();
    expect(c).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('returns version 4 (the 13th hex digit)', () => {
    const c = generateShareCode();
    expect(c.charAt(14)).toBe('4');
  });

  it('returns IETF variant (the 17th hex digit is 8|9|a|b)', () => {
    const c = generateShareCode();
    expect(['8', '9', 'a', 'b']).toContain(c.charAt(19));
  });

  it('returns distinct codes across many calls', () => {
    const N = 1000;
    const set = new Set<string>();
    for (let i = 0; i < N; i++) set.add(generateShareCode());
    expect(set.size).toBe(N);
  });

  it('uses lowercase only (so filesystem lookups stay deterministic)', () => {
    const c = generateShareCode();
    expect(c).toBe(c.toLowerCase());
  });
});

describe('isValidShareCode', () => {
  it('accepts a generated code', () => {
    expect(isValidShareCode(generateShareCode())).toBe(true);
  });

  it('rejects empty / non-string', () => {
    expect(isValidShareCode('')).toBe(false);
    expect(isValidShareCode(null)).toBe(false);
    expect(isValidShareCode(undefined)).toBe(false);
    expect(isValidShareCode(123)).toBe(false);
  });

  it('rejects uppercase hex (we only issue lowercase)', () => {
    expect(
      isValidShareCode('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    ).toBe(false);
  });

  it('rejects wrong version (non-4)', () => {
    expect(
      isValidShareCode('550e8400-e29b-11d4-a716-446655440000'),
    ).toBe(false);
  });

  it('rejects path-traversal attempts (no slashes, dots, nulls)', () => {
    expect(isValidShareCode('../etc/passwd')).toBe(false);
    expect(isValidShareCode('..%2fetc%2fpasswd')).toBe(false);
    expect(isValidShareCode('a/b/c')).toBe(false);
    expect(isValidShareCode('aaaaaaaa\0bbbbbbbb')).toBe(false);
  });

  it('rejects shorter or longer than 36 chars', () => {
    expect(isValidShareCode('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa')).toBe(
      false,
    );
    expect(isValidShareCode('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa')).toBe(
      false,
    );
  });
});
