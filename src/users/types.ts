export type UserKind = 'owner' | 'user';

export interface UserQuota {
  readonly cost: { readonly limitUsd: number | null; readonly usedUsd: number };
  readonly tokens: { readonly limit: number | null; readonly used: number };
}

/**
 * Mobile virtual-key toolbar customization. Persisted per-user; the
 * shapes below are the data model the server stores and returns.
 */
export type ToolbarKeyAction = 'plain' | 'ctrl-letter' | 'toggle-sticky-ctrl';

export interface ToolbarKey {
  readonly id: string;
  readonly label: string;
  // `| undefined` is explicit so zod's optional parse output assigns
  // cleanly under exactOptionalPropertyTypes.
  readonly ariaLabel?: string | undefined;
  readonly title?: string | undefined;
  readonly action: ToolbarKeyAction;
  readonly payload: string;
}

export interface ToolbarLayout {
  readonly rows: number;
  readonly cols: number;
  /** row-major, length = rows × cols. null = empty cell. */
  readonly cells: ReadonlyArray<ToolbarKey | null>;
}

export interface UserPreferences {
  readonly toolbar?: ToolbarLayout | undefined;
}

export interface User {
  readonly id: string;
  /** NFC-normalized; doubles as fs path component under workspace. */
  readonly username: string;
  readonly kind: UserKind;
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly quota: UserQuota;
  /** Per-user UI customization. Defaults to `{}` for legacy and fresh users. */
  readonly preferences: UserPreferences;
  /**
   * Cross-device-synced "last selected session". Server stores the id
   * verbatim; client validates against the live sessions list when
   * restoring (a stale id from a deleted session is silently ignored).
   * null = no selection.
   */
  readonly lastActiveSessionId: string | null;
}

/** Unicode letters + digits + space + underscore; length 1..32. NFC required. */
export const USERNAME_RE = /^[\p{L}\p{N} _]{1,32}$/u;

/** Toolbar layout bounds (enforced by zod on the wire + UserStore on persist). */
export const TOOLBAR_ROWS_MIN = 1;
export const TOOLBAR_ROWS_MAX = 3;
export const TOOLBAR_COLS_MIN = 3;
export const TOOLBAR_COLS_MAX = 8;
