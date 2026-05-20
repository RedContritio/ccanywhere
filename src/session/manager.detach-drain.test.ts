import { describe, it, expect } from 'vitest';
import { SessionManager } from './manager.js';

/**
 * Regression for .
 *
 * Background: detach() used to do `await Promise.allSettled([...pendingWrites])`
 * — a single snapshot. handleSessionExit (called from pty.onExit, which fires
 * during detach's await window if markDeleted's fire-and-forget kill() races)
 * uses trackWrite to enqueue post-exit writes (save + saveScreen). Those
 * writes were never awaited by detach, leaking into the moment after detach
 * returned — and racing readFile against fs.writeFile's open(O_TRUNC)→write
 * window, causing test reads to land on a zero-byte file (SyntaxError on
 * JSON.parse). Production shutdown (cli/serve.ts manager.detach()) had the
 * same vulnerability.
 *
 * Fix: detach() now loops until pendingWrites is empty. This test directly
 * exercises that loop without depending on real PTY timing — trackWrite is
 * used to schedule a "late" write from inside an "early" write's settling
 * callback, mirroring what handleSessionExit does in the real path.
 */
describe('SessionManager × detach loop drain', () => {
  it('drains writes added during the await window (not just snapshot)', async () => {
    const mgr = new SessionManager();
    type Testable = { trackWrite: (p: Promise<unknown>) => void };
    const trackWrite = (mgr as unknown as Testable).trackWrite.bind(mgr);

    let lateOpDone = false;
    const earlyOp = new Promise<void>((resolve) => {
      setTimeout(() => {
        // While we're still in the await window, enqueue a "late" write —
        // exactly what handleSessionExit does when pty.onExit fires.
        trackWrite(
          new Promise<void>((r2) => {
            setTimeout(() => {
              lateOpDone = true;
              r2();
            }, 10);
          }),
        );
        resolve();
      }, 10);
    });
    trackWrite(earlyOp);

    await mgr.detach();
    expect(lateOpDone).toBe(true);
  });

  it('returns immediately when pendingWrites is empty', async () => {
    const mgr = new SessionManager();
    // No trackWrite calls — detach should be a no-op.
    const start = Date.now();
    await mgr.detach();
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('drains a multi-generation chain (late op also schedules a later op)', async () => {
    const mgr = new SessionManager();
    type Testable = { trackWrite: (p: Promise<unknown>) => void };
    const trackWrite = (mgr as unknown as Testable).trackWrite.bind(mgr);

    const order: string[] = [];
    const gen1 = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('gen1');
        const gen2 = new Promise<void>((r2) => {
          setTimeout(() => {
            order.push('gen2');
            const gen3 = new Promise<void>((r3) => {
              setTimeout(() => {
                order.push('gen3');
                r3();
              }, 5);
            });
            trackWrite(gen3);
            r2();
          }, 5);
        });
        trackWrite(gen2);
        resolve();
      }, 5);
    });
    trackWrite(gen1);

    await mgr.detach();
    expect(order).toEqual(['gen1', 'gen2', 'gen3']);
  });
});
