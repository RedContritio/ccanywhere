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
}
