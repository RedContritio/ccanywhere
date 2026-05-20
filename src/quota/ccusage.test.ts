import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ccusageCalc } from './ccusage.js';
import { __resetWarnedForTest } from './pricing.js';

interface UsageBlock {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
}

function assistantLine(
  model: string,
  timestamp: string,
  usage: UsageBlock,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model,
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
    },
  });
}

describe('ccusageCalc', () => {
  let dir: string;
  let jsonl: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccanywhere-ccusage-'));
    jsonl = join(dir, 'test.jsonl');
    __resetWarnedForTest();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty rollup for missing file', async () => {
    const r = await ccusageCalc(join(dir, 'absent.jsonl'), 0);
    expect(r).toEqual({ costUsd: 0, totalTokens: 0, byModel: {} });
  });

  it('returns empty rollup for empty file', async () => {
    writeFileSync(jsonl, '');
    const r = await ccusageCalc(jsonl, 0);
    expect(r.costUsd).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.byModel).toEqual({});
  });

  it('sums one sonnet assistant line at standard rates', async () => {
    // sonnet: input 3, output 15, cacheRead 0.3, cacheCreation 3.75 per 1M
    // 1000 input + 500 output + 200 cacheRead + 100 cacheCreation:
    //   cost = (1000*3 + 500*15 + 200*0.3 + 100*3.75) / 1e6
    //        = (3000 + 7500 + 60 + 375) / 1e6 = 10935 / 1e6 = 0.010935
    writeFileSync(
      jsonl,
      assistantLine('claude-sonnet-4-6', '2026-04-16T08:22:52.400Z', {
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheCreation: 100,
      }) + '\n',
    );
    const r = await ccusageCalc(jsonl, 0);
    expect(r.totalTokens).toBe(1800); // 1000 + 500 + 200 + 100
    expect(r.costUsd).toBeCloseTo(0.010935, 6);
    expect(r.byModel['claude-sonnet-4-6']?.tokens).toBe(1800);
  });

  it('separates multi-model usage into byModel buckets', async () => {
    const lines = [
      assistantLine('claude-opus-4-7', '2026-04-16T08:22:00.000Z', { input: 100, output: 50 }),
      assistantLine('claude-sonnet-4-6', '2026-04-16T08:23:00.000Z', { input: 200, output: 80 }),
      assistantLine('claude-haiku-4-5', '2026-04-16T08:24:00.000Z', { input: 1000, output: 500 }),
    ].join('\n');
    writeFileSync(jsonl, lines + '\n');
    const r = await ccusageCalc(jsonl, 0);
    expect(Object.keys(r.byModel).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    expect(r.byModel['claude-opus-4-7']?.tokens).toBe(150);
    expect(r.byModel['claude-sonnet-4-6']?.tokens).toBe(280);
    expect(r.byModel['claude-haiku-4-5']?.tokens).toBe(1500);
  });

  it('filters out lines older than sinceTimestamp', async () => {
    const lines = [
      assistantLine('claude-sonnet-4-6', '2026-04-01T00:00:00.000Z', { input: 999 }),
      assistantLine('claude-sonnet-4-6', '2026-04-10T00:00:00.000Z', { input: 100 }),
    ].join('\n');
    writeFileSync(jsonl, lines + '\n');
    // sinceTimestamp = 2026-04-05 epoch-ms → first line dropped, second kept
    const since = Date.parse('2026-04-05T00:00:00.000Z');
    const r = await ccusageCalc(jsonl, since);
    expect(r.totalTokens).toBe(100);
  });

  it('skips non-assistant lines (user / queue-operation / etc)', async () => {
    const lines = [
      JSON.stringify({ type: 'queue-operation', timestamp: '2026-04-16T08:22:49.843Z' }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-16T08:22:49.854Z' }),
      assistantLine('claude-sonnet-4-6', '2026-04-16T08:22:52.400Z', { input: 100 }),
    ].join('\n');
    writeFileSync(jsonl, lines + '\n');
    const r = await ccusageCalc(jsonl, 0);
    expect(r.totalTokens).toBe(100);
  });

  it('survives corrupt lines without aborting the rollup', async () => {
    const lines = [
      assistantLine('claude-sonnet-4-6', '2026-04-16T08:22:52.400Z', { input: 100 }),
      'this is not json',
      assistantLine('claude-sonnet-4-6', '2026-04-16T08:23:52.400Z', { input: 200 }),
    ].join('\n');
    writeFileSync(jsonl, lines + '\n');
    const r = await ccusageCalc(jsonl, 0);
    expect(r.totalTokens).toBe(300);
  });

  it('cache_read is much cheaper than input for same token count (cost differential)', async () => {
    writeFileSync(
      jsonl,
      [
        assistantLine('claude-sonnet-4-6', '2026-04-16T08:22:52.400Z', { input: 1_000_000 }),
        assistantLine('claude-sonnet-4-6', '2026-04-16T08:23:52.400Z', { cacheRead: 1_000_000 }),
      ].join('\n') + '\n',
    );
    const r = await ccusageCalc(jsonl, 0);
    // input rate 3 USD / 1M, cacheRead 0.3 USD / 1M → total = 3.30
    expect(r.costUsd).toBeCloseTo(3.3, 6);
  });

  it('handles assistant line missing usage block (graceful skip)', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-16T08:22:52.400Z',
        message: { model: 'claude-sonnet-4-6' /* no usage */ },
      }),
      assistantLine('claude-sonnet-4-6', '2026-04-16T08:23:52.400Z', { input: 100 }),
    ].join('\n');
    writeFileSync(jsonl, lines + '\n');
    const r = await ccusageCalc(jsonl, 0);
    expect(r.totalTokens).toBe(100);
  });

  it('handles assistant line missing timestamp (skipped)', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 999 } },
      }),
      assistantLine('claude-sonnet-4-6', '2026-04-16T08:23:52.400Z', { input: 100 }),
    ].join('\n');
    writeFileSync(jsonl, lines + '\n');
    const r = await ccusageCalc(jsonl, 0);
    expect(r.totalTokens).toBe(100);
  });
});
