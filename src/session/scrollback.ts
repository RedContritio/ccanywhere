export class Scrollback {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  constructor(public readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
      throw new RangeError(`Scrollback maxBytes must be an integer >= 1024, got ${maxBytes}`);
    }
  }

  append(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buf.length === 0) return;

    this.chunks.push(buf);
    this.totalBytes += buf.length;

    while (this.chunks.length > 1 && this.totalBytes > this.maxBytes) {
      const head = this.chunks.shift();
      if (!head) break;
      this.totalBytes -= head.length;
    }

    if (this.chunks.length === 1 && this.totalBytes > this.maxBytes) {
      const only = this.chunks[0];
      if (!only) return;
      const sliced = only.subarray(only.length - this.maxBytes);
      const owned = Buffer.from(sliced);
      this.chunks = [owned];
      this.totalBytes = owned.length;
    }
  }

  snapshot(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  get bytes(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
