import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type UserKind = 'owner' | 'limited';

export interface AuthSnapshot {
  /**
   * Identity id from the last successful auth probe. For owner sessions
   * this is the device id (used by `navigator.credentials.get` to drive
   * webauthn login). For limited (token) sessions this is the user id.
   * Either is non-null = "logged in" as far as RequireAuth cares.
   * The actual session always lives in an HttpOnly cookie set by the server.
   */
  deviceId: string | null;
  label: string | null;
  /** owner = webauthn-paired device, limited = token-authenticated user. */
  kind: UserKind | null;
  /**
   * Heuristic: epoch-ms of the last successful auth (register-status
   * 'approved' / login-complete 200 / token-login 200 / me-probe 200).
   * UI uses this to decide whether to skip an immediate /api/auth/me
   * probe; it isn't trusted by the server.
   */
  verifiedAt: number | null;
}

interface AuthStore extends AuthSnapshot {
  setPaired: (deviceId: string, label: string) => void;
  setLimitedSession: (userId: string, username: string) => void;
  markVerified: () => void;
  logout: () => void;
}

const initial: AuthSnapshot = {
  deviceId: null,
  label: null,
  kind: null,
  verifiedAt: null,
};

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      ...initial,
      setPaired: (deviceId, label) =>
        set({ deviceId, label, kind: 'owner', verifiedAt: Date.now() }),
      setLimitedSession: (userId, username) =>
        set({ deviceId: userId, label: username, kind: 'limited', verifiedAt: Date.now() }),
      markVerified: () => set((s) => ({ ...s, verifiedAt: Date.now() })),
      logout: () => set({ ...initial }),
    }),
    {
      name: 'ccanywhere.auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        deviceId: s.deviceId,
        label: s.label,
        kind: s.kind,
        verifiedAt: s.verifiedAt,
      }),
    },
  ),
);

/** Reset store back to initial state. Tests only — do not call from app code. */
export function resetAuthStoreForTest(): void {
  useAuthStore.setState({ ...initial });
}
