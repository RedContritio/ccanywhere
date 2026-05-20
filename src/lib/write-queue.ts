/**
 * Per-key serialization helper used by stores that persist to disk and
 * need same-key writes to chain (avoid truncate-vs-partial-write races)
 * while keeping cross-key writes parallel. Extracted from share/store +
 * session/registry which had near-identical chains (m-write-queue-extract).
 *
 * Contract:
 *   - same key  enqueue(k,op1); enqueue(k,op2) → op2 starts only after
 *     op1 settles
 *   - diff key  enqueue('a',opA); enqueue('b',opB) → may run in parallel
 *   - rejection of an op does NOT block subsequent enqueue on the same
 *     key (caller's op is expected to log-and-swallow as before)
 *   - self-cleanup: when a chain fully settles, the Map entry for that
 *     key is removed so the queue doesn't grow unbounded
 */
export class WriteQueue<K extends string> {
  private readonly chains = new Map<K, Promise<unknown>>();

  enqueue<T>(key: K, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // .then(op, op) — run op whether prev resolved or rejected; rejection
    // of prev doesn't poison the chain for op.
    const next = prev.then(op, op);
    this.chains.set(key, next);
    // The cleanup chain inherits `next`'s rejection through .finally;
    // swallow it here so a rejected op doesn't show up as an
    // unhandledrejection. Caller still receives the rejection via the
    // returned `next` promise.
    next
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      })
      .catch(() => {});
    return next;
  }

  /** Resolves when all in-flight ops for `key` settle. If no chain
   *  exists (no pending op), resolves immediately. Used by tests that
   *  trigger fire-and-forget ops (e.g. lazy GC unlink) and need to wait
   *  for the IO to settle deterministically — replaces `setImmediate × N`
   *  guesswork. Rejections of in-flight ops are swallowed here (idle
   *  reports "queue drained" regardless of op outcome). */
  async idle(key: K): Promise<void> {
    const chain = this.chains.get(key);
    if (chain === undefined) return;
    try {
      await chain;
    } catch {
      // queue already swallows op rejection for chain bookkeeping; idle
      // observes the same drained state.
    }
  }
}
