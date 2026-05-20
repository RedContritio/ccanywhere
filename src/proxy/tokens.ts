import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export interface IssuedToken {
  /** Bearer string handed to claude via `ANTHROPIC_AUTH_TOKEN`. */
  readonly token: string;
  readonly userId: string;
  readonly expiresAt: number;
}

export interface VerifyResult {
  readonly userId: string;
  readonly expiresAt: number;
}

const PREFIX = 'cca';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // D2: 5-min rotation via apiKeyHelper

interface Payload {
  readonly uid: string;
  readonly exp: number;
  readonly nonce: string;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export interface TokenIssuerOpts {
  /** ≥32 bytes random; persist alongside proxy state for verify continuity. */
  readonly secret: Buffer;
  /** Default 5 min. */
  readonly defaultTtlMs?: number;
}

export class TokenIssuer {
  private readonly secret: Buffer;
  private readonly defaultTtlMs: number;

  constructor(opts: TokenIssuerOpts) {
    if (opts.secret.length < 32) {
      throw new TokenError(
        `secret must be ≥32 bytes (got ${opts.secret.length})`,
      );
    }
    this.secret = opts.secret;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  issue(userId: string, ttlMs?: number): IssuedToken {
    if (userId.length === 0) {
      throw new TokenError('userId must be non-empty');
    }
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    const payload: Payload = {
      uid: userId,
      exp: expiresAt,
      nonce: randomBytes(8).toString('base64url'),
    };
    const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload)));
    const mac = createHmac('sha256', this.secret).update(payloadB64).digest();
    const token = `${PREFIX}.${payloadB64}.${b64urlEncode(mac)}`;
    return { token, userId, expiresAt };
  }

  /**
   * Returns `null` for any verification failure (format / HMAC / expired).
   * Caller MUST treat null as "reject with 401" — never surface the
   * specific reason to the client (timing channel + leaks internals).
   */
  verify(token: string, now: number = Date.now()): VerifyResult | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [prefix, payloadB64, macB64] = parts;
    if (prefix !== PREFIX) return null;
    if (payloadB64 === undefined || macB64 === undefined) return null;

    let providedMac: Buffer;
    try {
      providedMac = b64urlDecode(macB64);
    } catch {
      return null;
    }
    const expectedMac = createHmac('sha256', this.secret)
      .update(payloadB64)
      .digest();
    if (providedMac.length !== expectedMac.length) return null;
    if (!timingSafeEqual(providedMac, expectedMac)) return null;

    let payload: Payload;
    try {
      payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as Payload;
    } catch {
      return null;
    }
    if (
      typeof payload.uid !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      return null;
    }
    if (payload.exp <= now) return null;
    return { userId: payload.uid, expiresAt: payload.exp };
  }
}
