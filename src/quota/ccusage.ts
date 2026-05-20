import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { priceFor } from './pricing.js';

/**
 * Per-model usage rollup. `tokens` is the sum of all four token categories
 * (input + output + cache_read + cache_creation) — matches what cc reports
 * as "total tokens" in its `/cost` slash command. Cost is computed
 * category-by-category against `pricing.ts`.
 */
export interface ByModelUsage {
  readonly tokens: number;
  readonly costUsd: number;
}

export interface UsageRollup {
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byModel: Record<string, ByModelUsage>;
}

interface AssistantLine {
  readonly type: 'assistant';
  readonly timestamp?: string;
  readonly message?: {
    readonly model?: string;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
    };
  };
}

const EMPTY_ROLLUP: UsageRollup = { costUsd: 0, totalTokens: 0, byModel: {} };

/**
 * Stream-parse a cc jsonl file and roll up token usage / dollar cost across
 * every `type: "assistant"` message whose `timestamp >= sinceTimestamp`.
 *
 * Streaming (not full read) keeps memory bounded for long-lived sessions
 * (jsonl can reach hundreds of MB after weeks of use). One-line-JSON-parse
 * failures are skipped with a warn — cc sometimes writes partial lines on
 * crash, and a single corrupt line must not zero out the rollup.
 *
 * `sinceTimestamp` is an epoch-ms (compatible with `User.createdAt`); cc
 * line timestamps are ISO strings, parsed via `Date.parse` per line.
 *
 * Returns an empty rollup for a missing or empty file — the hook's
 * first-prompt edge handler reads `existsSync` separately and decides
 * whether to treat-as-zero (proceed) versus the user being newly created
 * (skip persist).
 */
export async function ccusageCalc(
  jsonlPath: string,
  sinceTimestamp: number,
  warnOnce: (model: string) => void = defaultWarnOnce,
): Promise<UsageRollup> {
  if (!existsSync(jsonlPath)) return EMPTY_ROLLUP;

  const byModel: Record<string, { tokens: number; costUsd: number }> = {};
  let totalTokens = 0;
  let totalCost = 0;

  const stream = createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.length === 0) continue;
    let parsed: AssistantLine;
    try {
      parsed = JSON.parse(line) as AssistantLine;
    } catch {
      // Partial / corrupt line — skip without aborting the rollup.
      continue;
    }
    if (parsed.type !== 'assistant') continue;
    const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
    if (Number.isNaN(ts) || ts < sinceTimestamp) continue;

    const usage = parsed.message?.usage;
    const model = parsed.message?.model;
    if (!usage || typeof model !== 'string') continue;

    const inputT = usage.input_tokens ?? 0;
    const outputT = usage.output_tokens ?? 0;
    const cacheReadT = usage.cache_read_input_tokens ?? 0;
    const cacheCreateT = usage.cache_creation_input_tokens ?? 0;
    const tokens = inputT + outputT + cacheReadT + cacheCreateT;

    const rate = priceFor(model, warnOnce);
    const costUsd =
      (inputT * rate.input +
        outputT * rate.output +
        cacheReadT * rate.cacheRead +
        cacheCreateT * rate.cacheCreation) /
      1_000_000;

    const bucket = byModel[model] ?? { tokens: 0, costUsd: 0 };
    bucket.tokens += tokens;
    bucket.costUsd += costUsd;
    byModel[model] = bucket;

    totalTokens += tokens;
    totalCost += costUsd;
  }

  return { costUsd: totalCost, totalTokens, byModel };
}

function defaultWarnOnce(model: string): void {
  console.warn(`[quota.ccusage] unknown model: ${model}`);
}
