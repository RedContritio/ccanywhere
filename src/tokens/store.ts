import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TOKEN_TTL_MAX_MS, type Token } from './types.js';

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenStoreError';
  }
}

interface PersistedState {
  readonly tokens: ReadonlyArray<Token>;
}

export interface TokenStoreOptions {
  readonly statePath: string;
  readonly now?: () => number;
}

export interface IssueTokenInput {
  readonly userId: string;
  readonly ttlMs: number;
  readonly label?: string | null;
}

export interface IssuedToken {
  readonly token: Token;
  /** Plaintext, returned once at issue time and never persisted. */
  readonly plaintext: string;
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export class TokenStore {
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly tokens = new Map<string, Token>();

  constructor(opts: TokenStoreOptions) {
    this.statePath = opts.statePath;
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  list(userId?: string): Token[] {
    const all = Array.from(this.tokens.values());
    const filtered = userId === undefined ? all : all.filter((t) => t.userId === userId);
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  }

  findById(id: string): Token | null {
    return this.tokens.get(id) ?? null;
  }

  issue(input: IssueTokenInput): IssuedToken {
    if (input.ttlMs <= 0 || input.ttlMs > TOKEN_TTL_MAX_MS) {
      throw new TokenStoreError(
        `ttl out of range: must be > 0 and <= ${TOKEN_TTL_MAX_MS}ms (7d)`,
      );
    }
    const plaintext = randomBytes(32).toString('hex');
    const now = this.now();
    const token: Token = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: hashToken(plaintext),
      label: input.label ?? null,
      createdAt: now,
      expiresAt: now + input.ttlMs,
      status: 'active',
    };
    this.tokens.set(token.id, token);
    this.persist();
    return { token, plaintext };
  }

  /**
   * Constant-time lookup by plaintext. Iterates all tokens regardless of
   * early match so timing leaks no info about which entry matched. Cost
   * O(N); N is small (one-token-per-limited-user, expect <100).
   */
  verify(plaintext: string): Token | null {
    const targetBuf = Buffer.from(hashToken(plaintext), 'hex');
    const now = this.now();
    let found: Token | null = null;
    for (const t of this.tokens.values()) {
      const candidateBuf = Buffer.from(t.tokenHash, 'hex');
      if (candidateBuf.length !== targetBuf.length) continue;
      const eq = timingSafeEqual(candidateBuf, targetBuf);
      if (eq && t.status === 'active' && t.expiresAt > now) {
        found = t;
      }
    }
    return found;
  }

  revoke(tokenId: string): boolean {
    const t = this.tokens.get(tokenId);
    if (!t || t.status === 'revoked') return false;
    this.tokens.set(tokenId, { ...t, status: 'revoked' });
    this.persist();
    return true;
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.statePath, 'utf8');
    } catch {
      return;
    }
    let parsed: Partial<PersistedState>;
    try {
      parsed = JSON.parse(raw) as Partial<PersistedState>;
    } catch {
      return;
    }
    if (Array.isArray(parsed.tokens)) {
      for (const t of parsed.tokens) {
        if (typeof t?.id === 'string') this.tokens.set(t.id, t);
      }
    }
  }

  private persist(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state: PersistedState = { tokens: Array.from(this.tokens.values()) };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
