/**
 * Ring buffer of raw PTY bytes with a monotonic cumulative byte counter.
 *
 * Two distinct numbers:
 *   - `headSeq`  total bytes ever appended to this scrollback (monotonic).
 *   - `tailSeq`  oldest seq still retained — anything < tailSeq has been
 *                evicted by ring rotation. `headSeq - tailSeq === bufferedBytes`.
 *
 * `since(seq)` returns the bytes in `(seq, headSeq]` if `seq` is still in
 * the ring; null if `seq < tailSeq` (caller must fall back to a full
 * snapshot). Used by ws reconnect to send incremental delta instead of
 * full state.
 */
export class Scrollback {
  private chunks: Buffer[] = [];
  /** Cumulative bytes ever appended. Equals `tailSeq + bufferedBytes`. */
  private headSeqValue = 0;
  /** Oldest seq still retained in the buffer (== bytes evicted so far). */
  private tailSeqValue = 0;

  constructor(public readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
      throw new RangeError(`Scrollback maxBytes must be an integer >= 1024, got ${maxBytes}`);
    }
  }

  append(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buf.length === 0) return;

    this.chunks.push(buf);
    this.headSeqValue += buf.length;
    let buffered = this.bufferedBytes();

    while (this.chunks.length > 1 && buffered > this.maxBytes) {
      const head = this.chunks.shift();
      if (!head) break;
      this.tailSeqValue += head.length;
      buffered -= head.length;
    }

    if (this.chunks.length === 1 && buffered > this.maxBytes) {
      const only = this.chunks[0];
      if (!only) return;
      const dropped = only.length - this.maxBytes;
      const sliced = only.subarray(dropped);
      const owned = Buffer.from(sliced);
      this.chunks = [owned];
      this.tailSeqValue += dropped;
    }
  }

  snapshot(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  /**
   * Return bytes appended after `seq` (exclusive) up to `headSeq`. Returns
   * null if `seq` is older than what we still have buffered (the caller
   * should fall back to a full snapshot).
   */
  since(seq: number): string | null {
    if (seq < this.tailSeqValue) return null;
    if (seq >= this.headSeqValue) return '';
    const offsetIntoBuffer = seq - this.tailSeqValue;
    const concatenated = Buffer.concat(this.chunks);
    return concatenated.subarray(offsetIntoBuffer).toString('utf8');
  }

  get headSeq(): number {
    return this.headSeqValue;
  }

  get tailSeq(): number {
    return this.tailSeqValue;
  }

  /** Buffered bytes currently in the ring (== headSeq - tailSeq). */
  get bytes(): number {
    return this.headSeqValue - this.tailSeqValue;
  }

  private bufferedBytes(): number {
    return this.headSeqValue - this.tailSeqValue;
  }

  clear(): void {
    this.chunks = [];
    // Note: clear() does NOT reset headSeq — restarting the ring keeps the
    // session-wide cumulative counter monotonic so that any client still
    // holding a `lastSeq` from before the clear is correctly downgraded
    // to "fall back to snapshot" by the since(seq) < tailSeq check.
    this.tailSeqValue = this.headSeqValue;
  }
}
