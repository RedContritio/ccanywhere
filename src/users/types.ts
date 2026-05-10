export type UserKind = 'owner' | 'limited';

export interface UserQuota {
  readonly cost: { readonly limitUsd: number | null; readonly usedUsd: number };
  readonly tokens: { readonly limit: number | null; readonly used: number };
}

export interface User {
  readonly id: string;
  /** NFC-normalized; doubles as fs path component for limited users. */
  readonly username: string;
  readonly kind: UserKind;
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly quota: UserQuota;
}

/** Unicode letters + digits + space + underscore; length 1..32. NFC required. */
export const USERNAME_RE = /^[\p{L}\p{N} _]{1,32}$/u;
