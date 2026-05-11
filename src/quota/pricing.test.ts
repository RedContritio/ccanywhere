import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetWarnedForTest, priceFor } from './pricing.js';

describe('priceFor', () => {
  afterEach(() => {
    __resetWarnedForTest();
  });

  it('returns opus rate for any opus-prefixed model id', () => {
    const r = priceFor('claude-opus-4-7');
    expect(r.input).toBe(15);
    expect(r.output).toBe(75);
    expect(r.cacheRead).toBe(1.5);
    expect(r.cacheCreation).toBe(18.75);
  });

  it('returns sonnet rate for any sonnet-prefixed model id', () => {
    const r = priceFor('claude-sonnet-4-6');
    expect(r.input).toBe(3);
    expect(r.output).toBe(15);
    expect(r.cacheRead).toBe(0.3);
    expect(r.cacheCreation).toBe(3.75);
  });

  it('returns haiku rate for any haiku-prefixed model id (date suffix tolerated)', () => {
    const r = priceFor('claude-haiku-4-5-20251001');
    expect(r.input).toBe(1);
    expect(r.output).toBe(5);
    expect(r.cacheRead).toBe(0.1);
    expect(r.cacheCreation).toBe(1.25);
  });

  it('cache_read is strictly cheaper than input (input cache amortization)', () => {
    for (const m of ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      const r = priceFor(m);
      expect(r.cacheRead).toBeLessThan(r.input);
    }
  });

  it('cache_creation is more expensive than input (write-through penalty)', () => {
    for (const m of ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      const r = priceFor(m);
      expect(r.cacheCreation).toBeGreaterThan(r.input);
    }
  });

  it('unknown model returns 0 rate (fail-soft, does not throw)', () => {
    const warn = vi.fn();
    const r = priceFor('claude-mystery-9-9', warn);
    expect(r.input).toBe(0);
    expect(r.output).toBe(0);
    expect(r.cacheRead).toBe(0);
    expect(r.cacheCreation).toBe(0);
    expect(warn).toHaveBeenCalledWith('claude-mystery-9-9');
  });

  it('warns once per unknown model across repeated lookups', () => {
    const warn = vi.fn();
    priceFor('claude-mystery-9-9', warn);
    priceFor('claude-mystery-9-9', warn);
    priceFor('claude-mystery-9-9', warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
