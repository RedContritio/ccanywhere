export type TokenStatus = 'active' | 'revoked';

export interface Token {
  readonly id: string;
  readonly userId: string;
  /** sha256(plaintext) hex; the plaintext is returned once at issue time. */
  readonly tokenHash: string;
  readonly label: string | null;
  readonly createdAt: number;
  /** epoch-ms; <= createdAt + 7d (hardcoded). */
  readonly expiresAt: number;
  readonly status: TokenStatus;
}

export const TOKEN_TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
