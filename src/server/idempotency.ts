import { createHash } from 'node:crypto';

export type LookupResult =
  | { kind: 'miss' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' };

interface Entry {
  bodyHash: string;
  status: number;
  body: unknown;
  expiresAt: number;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(',')}}`;
}

export function hashBody(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

export class IdempotencyStore {
  private readonly map = new Map<string, Entry>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly ttlMs: number,
    sweepIntervalMs: number = 5 * 60 * 1000,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`IdempotencyStore ttlMs must be a positive number, got ${ttlMs}`);
    }
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  lookup(scope: string, key: string, bodyHash: string): LookupResult {
    const k = `${scope}\x00${key}`;
    const entry = this.map.get(k);
    if (!entry) return { kind: 'miss' };
    if (entry.expiresAt < Date.now()) {
      this.map.delete(k);
      return { kind: 'miss' };
    }
    if (entry.bodyHash !== bodyHash) return { kind: 'conflict' };
    return { kind: 'replay', status: entry.status, body: entry.body };
  }

  store(
    scope: string,
    key: string,
    bodyHash: string,
    status: number,
    body: unknown,
  ): void {
    if (status < 200 || status >= 500) return;
    const k = `${scope}\x00${key}`;
    this.map.set(k, {
      bodyHash,
      status,
      body,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  size(): number {
    return this.map.size;
  }

  close(): void {
    clearInterval(this.sweepTimer);
    this.map.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.map) {
      if (e.expiresAt < now) this.map.delete(k);
    }
  }
}
