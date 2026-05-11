/**
 * Anthropic model pricing per 1,000,000 tokens (USD).
 *
 * Source: https://www.anthropic.com/pricing — values reflect public
 * list pricing for the Claude 4 family as of 2026-05.
 *
 * Sync strategy: when Anthropic announces new models / pricing, update
 * this table and bump the cited date above. There is no auto-sync (cc
 * jsonl carries the model name so we can keep the rate table local).
 *
 * Matching: model strings in cc jsonl look like `claude-opus-4-7`,
 * `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. We prefix-match by
 * family so date-suffixed variants pick up the family rate.
 */

export interface ModelRate {
  /** USD per 1M input tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

const ZERO_RATE: ModelRate = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

const FAMILY_RATES: ReadonlyArray<{ readonly prefix: string; readonly rate: ModelRate }> = [
  {
    prefix: 'claude-opus',
    rate: { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  },
  {
    prefix: 'claude-sonnet',
    rate: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  },
  {
    prefix: 'claude-haiku',
    rate: { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  },
];

const warnedUnknown = new Set<string>();

/**
 * Returns the rate table for `model`. Unknown family → ZERO_RATE (fail-soft;
 * usage still counts toward `totalTokens`, just yields $0 cost). Each unknown
 * model is logged once via the supplied logger to surface pricing-table drift
 * after cc upgrades without spamming.
 */
export function priceFor(
  model: string,
  warnOnce: (model: string) => void = defaultWarn,
): ModelRate {
  for (const { prefix, rate } of FAMILY_RATES) {
    if (model.startsWith(prefix)) return rate;
  }
  if (!warnedUnknown.has(model)) {
    warnedUnknown.add(model);
    warnOnce(model);
  }
  return ZERO_RATE;
}

function defaultWarn(model: string): void {
  console.warn(`[quota.pricing] unknown model: ${model} — cost contribution 0`);
}

/**
 * @internal — test-only; resets the once-warned set so multiple test
 * cases can observe the warn callback.
 */
export function __resetWarnedForTest(): void {
  warnedUnknown.clear();
}
