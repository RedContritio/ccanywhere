import { afterEach, describe, expect, it } from 'vitest';
import { MAX_OPS, recordOp, recordOpThrottled, resetOpsForTest, snapshotOps } from './ops-log.js';

describe('ops-log', () => {
  afterEach(() => {
    resetOpsForTest();
  });

  it('caps the ring at MAX_OPS — contract with server feedback schema', () => {
    // Contract guard: server `FeedbackBodySchema.ops` cap MUST stay >=
    // MAX_OPS. The schema cap is set well above MAX_OPS in
    // src/server/routes/feedback.ts so this stays satisfied even when
    // we tune the retention window / peak rate inputs. Regression
    // caught manually when server was 100 and client was 200: dogfood
    // feedback got a silent 400 invalid_request.
    const overflow = 50;
    for (let i = 0; i < MAX_OPS + overflow; i++) recordOp('test.kind', { i });
    const ops = snapshotOps();
    expect(ops).toHaveLength(MAX_OPS);
    // The first `overflow` entries should have been evicted (FIFO).
    expect(ops[0]?.payload?.['i']).toBe(overflow);
    expect(ops.at(-1)?.payload?.['i']).toBe(MAX_OPS + overflow - 1);
  });

  it('MAX_OPS is sized to retain the documented window without weird tiny defaults', () => {
    // Sanity floor: keep regression-resistant. If someone changes the
    // input constants and accidentally collapses the budget to a tiny
    // value, this catches it before it ships.
    expect(MAX_OPS).toBeGreaterThanOrEqual(1_000);
    expect(MAX_OPS).toBeLessThan(20_000); // server runaway guard
  });

  it('records ts as monotonic Date.now() at insertion', () => {
    const t0 = Date.now();
    recordOp('a');
    recordOp('b', { x: 1 });
    const ops = snapshotOps();
    expect(ops).toHaveLength(2);
    expect(ops[0]!.kind).toBe('a');
    expect(ops[1]!.kind).toBe('b');
    expect(ops[0]!.ts).toBeGreaterThanOrEqual(t0);
    expect(ops[1]!.ts).toBeGreaterThanOrEqual(ops[0]!.ts);
    expect(ops[0]!.payload).toBeUndefined();
    expect(ops[1]!.payload).toEqual({ x: 1 });
  });

  it('throttles by kind: only first call within intervalMs is recorded', () => {
    recordOpThrottled('drag', { i: 0 }, 1_000);
    recordOpThrottled('drag', { i: 1 }, 1_000);
    recordOpThrottled('drag', { i: 2 }, 1_000);
    // Different kind shares no rate-limit window.
    recordOpThrottled('zoom', { i: 0 }, 1_000);
    const ops = snapshotOps();
    expect(ops.map((o) => o.kind)).toEqual(['drag', 'zoom']);
    expect(ops[0]!.payload).toEqual({ i: 0 });
  });
});
