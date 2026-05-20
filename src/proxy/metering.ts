import { priceFor } from '../quota/pricing.js';

/**
 * Anthropic /v1/messages response usage block. All fields optional —
 * older responses omit cache_* (no cache hit / older API), and the
 * proxy must tolerate either shape.
 */
export interface UpstreamUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export interface ResponseShape {
  readonly model?: string;
  readonly usage?: UpstreamUsage;
}

export interface MeterResult {
  readonly costUsd: number;
  readonly totalTokens: number;
}

/**
 * Compute USD cost + total tokens for one upstream response. Unknown
 * model → ZERO_RATE (cost 0 but tokens still counted); missing usage
 * or model → returns zeros. Caller (forward route) decides whether to
 * persist (D3: only 2xx upstream responses are metered; 4xx/5xx skip
 * to avoid double-counting under SDK retry).
 */
export function meterResponse(response: ResponseShape): MeterResult {
  if (response.model === undefined || response.usage === undefined) {
    return { costUsd: 0, totalTokens: 0 };
  }
  const rate = priceFor(response.model);
  const u = response.usage;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;

  // Rates are per 1M tokens.
  const costUsd =
    (input * rate.input +
      output * rate.output +
      cacheRead * rate.cacheRead +
      cacheCreate * rate.cacheCreation) /
    1_000_000;

  return {
    costUsd,
    totalTokens: input + output + cacheRead + cacheCreate,
  };
}
