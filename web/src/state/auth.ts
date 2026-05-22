import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type UserKind = 'owner' | 'limited';

/**
 * One plaintext token previously used to log in as a specific limited
 * user. `expiresAt` is client-side estimated (login time + token TTL,
 * default 7d) — server response doesn't currently expose the exact
 * expiry, so this is a heuristic for ordering ("try the longest-lived
 * one first"), not a hard cutoff.
 */
export interface TokenRecord {
  token: string;
  expiresAt: number;
}

/**
 * One limited user the machine has logged in as at least once. Holds
 * every token plaintext that has succeeded for this user so far; the
 * login UI tries them newest-expiry-first.
 */
export interface LimitedUserRecord {
  userId: string;
  username: string;
  tokens: TokenRecord[];
}

export interface AuthSnapshot {
  /**
   * **Active session** — gate for `RequireAuth`. Non-null only between
   * a successful auth (setPaired / setLimitedSession) and the next
   * clearSession / unpair. The actual cookie lives server-side; this is
   * the local fingerprint of "I'm currently logged in as X".
   *
   * For owner this is the device id; for limited this is the user id.
   * Cleared by `clearSession` — RequireAuth then auto-redirects to
   * /login, where the stored credential slots below drive the UI.
   */
  deviceId: string | null;
  label: string | null;
  /** owner = webauthn-paired device, limited = token-authenticated user. */
  kind: UserKind | null;
  /**
   * Heuristic: epoch-ms of the last successful auth. UI uses it to
   * decide whether to skip an immediate /api/auth/me probe; it isn't
   * trusted by the server. Always cleared together with the active
   * session on `clearSession`.
   */
  verifiedAt: number | null;

  // --- Stored credential cache (survives clearSession) ---
  //
  // owner is single-slot (one webauthn credential per device).
  // limited supports multiple users, each with multiple tokens —
  // /login lists every user and tries their stored tokens in order.

  /** Webauthn device id from the last successful pair / login. */
  ownerDeviceId: string | null;
  /** Human-readable device label saved alongside `ownerDeviceId`. */
  ownerLabel: string | null;
  /** Every limited user the machine has logged in as. */
  limitedUsers: LimitedUserRecord[];
}

interface AuthStore extends AuthSnapshot {
  setPaired: (deviceId: string, label: string) => void;
  /**
   * `token` is the plaintext token the user just submitted to
   * `/api/auth/token`. Stored under `limitedUsers[userId].tokens` so
   * the next /login can offer one-tap re-auth. `ttlMs` is the client-
   * estimated lifetime used to seed `expiresAt`; pass `null` if the
   * caller doesn't have the plaintext (e.g. probeSession rehydrating
   * an existing cookie session — we only know the user id).
   */
  setLimitedSession: (
    userId: string,
    username: string,
    token: string | null,
    ttlMs?: number,
  ) => void;
  markVerified: () => void;
  /**
   * Soft logout: clear the **active session** (deviceId / label / kind /
   * verifiedAt) so RequireAuth redirects to /login. Stored credentials
   * (ownerDeviceId / ownerLabel / limitedUserId / limitedUsername /
   * lastToken) are preserved so /login can offer one-tap re-auth on
   * whichever path the user originally used.
   */
  clearSession: () => void;
  /**
   * Hard logout: clear everything (active + stored credentials).
   * Use only when the webauthn credential is known to be invalid
   * (server-side revoke detected via 401 on a webauthn-login attempt)
   * or when the user explicitly wants to forget this device.
   */
  unpair: () => void;
  /**
   * Remove one specific token from one limited user. Called when a
   * specific token-login fails — we still want the user's other tokens
   * (if any) on the menu.
   */
  forgetToken: (userId: string, token: string) => void;
  /**
   * Drop an entire limited user (all their tokens). Called when every
   * stored token for that user has been tried and failed.
   */
  forgetLimitedUser: (userId: string) => void;
  /**
   * Forget the cached owner device credential without touching the
   * limited list. Called when webauthn-login returns false (credential
   * revoked / unknown on the server) so the next /login visit drops
   * the "用本机生物识别登入" button but still offers any token path.
   */
  forgetOwnerCredential: () => void;
}

/**
 * Server-side token TTL is 7d (TOKEN_TTL_MAX_MS) and the issue API
 * doesn't return the exact expiry. The client estimates by now + 7d
 * for sort-ordering "try longest-lived first". This is a heuristic;
 * the server is still the authority on validity.
 */
export const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const initial: AuthSnapshot = {
  deviceId: null,
  label: null,
  kind: null,
  verifiedAt: null,
  ownerDeviceId: null,
  ownerLabel: null,
  limitedUsers: [],
};

/**
 * Add or refresh one token under one limited user. Dedup is by
 * **username** (not userId): if the operator deletes + recreates
 * a user, the server picks a fresh userId for the same name, but the
 * login page should still show one entry, not two. Token-level dedup is
 * by plaintext (same plaintext just bumps expiresAt).
 */
function upsertToken(
  users: readonly LimitedUserRecord[],
  userId: string,
  username: string,
  token: string,
  expiresAt: number,
): LimitedUserRecord[] {
  const existing = users.find((u) => u.username === username);
  if (existing === undefined) {
    return [...users, { userId, username, tokens: [{ token, expiresAt }] }];
  }
  const tokens = existing.tokens.some((t) => t.token === token)
    ? existing.tokens.map((t) =>
        t.token === token ? { token, expiresAt } : t,
      )
    : [...existing.tokens, { token, expiresAt }];
  // Replace userId with the freshest reference (server-side rename / recreate).
  return users.map((u) =>
    u.username === username ? { userId, username, tokens } : u,
  );
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      ...initial,
      setPaired: (deviceId, label) =>
        set((s) => ({
          ...s,
          deviceId,
          label,
          kind: 'owner',
          verifiedAt: Date.now(),
          ownerDeviceId: deviceId,
          ownerLabel: label,
          // limitedUsers untouched — multi-credential machine.
        })),
      setLimitedSession: (userId, username, token, ttlMs) =>
        set((s) => ({
          ...s,
          deviceId: userId,
          label: username,
          kind: 'limited',
          verifiedAt: Date.now(),
          limitedUsers:
            token === null
              ? // Probe rehydration: we know the user is logged in but
                // never saw the plaintext token. Make sure the user has
                // a record (with empty token list if new), don't fake
                // tokens we never observed. Dedup by username.
                s.limitedUsers.some((u) => u.username === username)
                ? s.limitedUsers.map((u) =>
                    u.username === username ? { ...u, userId } : u,
                  )
                : [...s.limitedUsers, { userId, username, tokens: [] }]
              : upsertToken(
                  s.limitedUsers,
                  userId,
                  username,
                  token,
                  Date.now() + (ttlMs ?? DEFAULT_TOKEN_TTL_MS),
                ),
        })),
      markVerified: () => set((s) => ({ ...s, verifiedAt: Date.now() })),
      clearSession: () =>
        set((s) => ({
          ...s,
          deviceId: null,
          label: null,
          kind: null,
          verifiedAt: null,
        })),
      unpair: () => set({ ...initial }),
      forgetToken: (userId, token) =>
        set((s) => ({
          ...s,
          limitedUsers: s.limitedUsers.map((u) =>
            u.userId === userId
              ? { ...u, tokens: u.tokens.filter((t) => t.token !== token) }
              : u,
          ),
        })),
      forgetLimitedUser: (userId) =>
        set((s) => ({
          ...s,
          limitedUsers: s.limitedUsers.filter((u) => u.userId !== userId),
          // If the active session was this very user, drop it too — the
          // tokens we'd use to re-auth are all gone.
          ...(s.kind === 'limited' && s.deviceId === userId
            ? { deviceId: null, label: null, kind: null, verifiedAt: null }
            : {}),
        })),
      forgetOwnerCredential: () =>
        set((s) => ({
          ...s,
          ownerDeviceId: null,
          ownerLabel: null,
          ...(s.kind === 'owner'
            ? { deviceId: null, label: null, kind: null, verifiedAt: null }
            : {}),
        })),
    }),
    {
      name: 'ccanywhere.auth',
      storage: createJSONStorage(() => localStorage),
      // bump to v2 so existing localStorage runs the dedupe-by-username
      // migration once. Operators who deleted + recreated a user (or had
      // pre-dedup duplicates) collapse to one entry on next page load.
      version: 2,
      migrate: (persisted, fromVersion) => {
        const s = (persisted ?? {}) as Partial<AuthSnapshot>;
        if (fromVersion < 2) {
          const users = s.limitedUsers ?? [];
          const byUsername = new Map<string, LimitedUserRecord>();
          for (const u of users) {
            const prev = byUsername.get(u.username);
            const merged: LimitedUserRecord = {
              userId: u.userId,
              username: u.username,
              tokens:
                prev === undefined
                  ? u.tokens
                  : // Concat + dedup by plaintext (keep latest expiresAt).
                    Array.from(
                      [...prev.tokens, ...u.tokens]
                        .reduce<Map<string, TokenRecord>>((acc, t) => {
                          const existing = acc.get(t.token);
                          if (existing === undefined || t.expiresAt > existing.expiresAt) {
                            acc.set(t.token, t);
                          }
                          return acc;
                        }, new Map())
                        .values(),
                    ),
            };
            byUsername.set(u.username, merged);
          }
          return { ...s, limitedUsers: Array.from(byUsername.values()) };
        }
        return s;
      },
      partialize: (s) => ({
        deviceId: s.deviceId,
        label: s.label,
        kind: s.kind,
        verifiedAt: s.verifiedAt,
        ownerDeviceId: s.ownerDeviceId,
        ownerLabel: s.ownerLabel,
        limitedUsers: s.limitedUsers,
      }),
    },
  ),
);

/** Reset store back to initial state. Tests only — do not call from app code. */
export function resetAuthStoreForTest(): void {
  useAuthStore.setState({ ...initial });
}
