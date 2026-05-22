import { describe, expect, it } from 'vitest';
import { meterResponse } from './metering.js';
import { __resetWarnedForTest } from '../quota/pricing.js';

describe('meterResponse', () => {
  it('returns zeros when model missing', () => {
    const r = meterResponse({ usage: { input_tokens: 10, output_tokens: 20 } });
    expect(r).toEqual({ costUsd: 0, totalTokens: 0 });
  });

  it('returns zeros when usage missing', () => {
    const r = meterResponse({ model: 'claude-opus-4-7' });
    expect(r).toEqual({ costUsd: 0, totalTokens: 0 });
  });

  it('computes USD cost for opus family (15 in / 75 out per 1M)', () => {
    const r = meterResponse({
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    // 15 + 75 = 90 USD
    expect(r.costUsd).toBeCloseTo(90);
    expect(r.totalTokens).toBe(2_000_000);
  });

  it('computes USD cost for sonnet family (3 in / 15 out per 1M)', () => {
    const r = meterResponse({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    expect(r.costUsd).toBeCloseTo(18);
  });

  it('includes cache_read and cache_creation tokens', () => {
    const r = meterResponse({
      model: 'claude-opus-4-7',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000, // 1.5/1M
        cache_creation_input_tokens: 1_000_000, // 18.75/1M
      },
    });
    // 15 + 0 + 1.5 + 18.75 = 35.25
    expect(r.costUsd).toBeCloseTo(35.25);
    expect(r.totalTokens).toBe(3_000_000);
  });

  it('unknown model family → cost 0 but tokens still counted (fail-soft)', () => {
    __resetWarnedForTest();
    const r = meterResponse({
      model: 'claude-future-model-2099',
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    expect(r.costUsd).toBe(0);
    expect(r.totalTokens).toBe(300);
  });

  it('handles partial usage (only input_tokens) without NaN', () => {
    const r = meterResponse({
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 1_000_000 },
    });
    // haiku input=1/1M
    expect(r.costUsd).toBeCloseTo(1);
    expect(r.totalTokens).toBe(1_000_000);
    expect(Number.isFinite(r.costUsd)).toBe(true);
  });
});
