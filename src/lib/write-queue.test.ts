import { describe, expect, it } from 'vitest';
import { WriteQueue } from './write-queue.js';

describe('WriteQueue', () => {
  it('same key: op2 starts only after op1 settles', async () => {
    const q = new WriteQueue<string>();
    const order: string[] = [];
    const p1 = q.enqueue('k', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('op1-end');
    });
    const p2 = q.enqueue('k', async () => {
      order.push('op2-start');
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['op1-end', 'op2-start']);
  });

  it('different keys: ops run in parallel', async () => {
    const q = new WriteQueue<string>();
    let aRunning = false;
    let bSawARunning = false;
    const pA = q.enqueue('a', async () => {
      aRunning = true;
      await new Promise((r) => setTimeout(r, 30));
      aRunning = false;
    });
    const pB = q.enqueue('b', async () => {
      // If 'b' had to wait for 'a', aRunning would already be false here.
      bSawARunning = aRunning;
    });
    await Promise.all([pA, pB]);
    expect(bSawARunning).toBe(true);
  });

  it('rejection of prior op does not block subsequent enqueue on same key', async () => {
    const q = new WriteQueue<string>();
    const p1 = q.enqueue('k', async () => {
      throw new Error('first op failed');
    });
    // p1 rejects, but p2 must still execute and resolve.
    const p2 = q.enqueue('k', async () => 'ok');
    await expect(p1).rejects.toThrow('first op failed');
    await expect(p2).resolves.toBe('ok');
  });

  it('chain settles → key removed from internal Map (no unbounded growth)', async () => {
    const q = new WriteQueue<string>();
    const internal = q as unknown as { chains: Map<string, Promise<unknown>> };
    await q.enqueue('k', async () => 'done');
    // finally callback runs after the await microtask; one more tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(internal.chains.has('k')).toBe(false);
  });

  it('returns op result (typed)', async () => {
    const q = new WriteQueue<string>();
    const v = await q.enqueue('k', async () => 42);
    expect(v).toBe(42);
  });

  it('idle(unknown key) resolves immediately', async () => {
    const q = new WriteQueue<string>();
    await expect(q.idle('never-enqueued')).resolves.toBeUndefined();
  });

  it('idle(key) waits for in-flight op to complete', async () => {
    const q = new WriteQueue<string>();
    let opDone = false;
    void q.enqueue('k', async () => {
      await new Promise((r) => setTimeout(r, 20));
      opDone = true;
    });
    await q.idle('k');
    expect(opDone).toBe(true);
  });

  it('idle(key) waits for the whole chain, not just the latest op', async () => {
    const q = new WriteQueue<string>();
    const order: string[] = [];
    void q.enqueue('k', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('op1');
    });
    void q.enqueue('k', async () => {
      order.push('op2');
    });
    await q.idle('k');
    expect(order).toEqual(['op1', 'op2']);
  });

  it('idle(key) after the chain drains resolves immediately', async () => {
    const q = new WriteQueue<string>();
    await q.enqueue('k', async () => 'done');
    // chain cleanup runs in finally microtask; one tick.
    await new Promise((r) => setTimeout(r, 0));
    // No chain for 'k' anymore — idle resolves on the undefined branch.
    await expect(q.idle('k')).resolves.toBeUndefined();
  });

  it('idle(key) swallows op rejection (reports drained regardless)', async () => {
    const q = new WriteQueue<string>();
    const p = q.enqueue('k', async () => {
      throw new Error('op failed');
    });
    // Caller observes rejection via the returned promise; idle does not.
    await expect(p).rejects.toThrow('op failed');
    await expect(q.idle('k')).resolves.toBeUndefined();
  });
});
