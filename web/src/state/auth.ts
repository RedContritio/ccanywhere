import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface AuthSnapshot {
  /**
   * Device id assigned at pair time. We persist this so the next visit
   * knows which credential to ask for in `navigator.credentials.get`. The
   * actual session lives in an HttpOnly cookie set by the server.
   */
  deviceId: string | null;
  label: string | null;
  /**
   * Heuristic: epoch-ms of the last successful auth (register-status
   * 'approved' or login-complete 200). UI uses this to decide whether to
   * skip an immediate /api/auth/me probe; it isn't trusted by the server.
   */
  verifiedAt: number | null;
}

interface AuthStore extends AuthSnapshot {
  setPaired: (deviceId: string, label: string) => void;
  markVerified: () => void;
  logout: () => void;
}

const initial: AuthSnapshot = { deviceId: null, label: null, verifiedAt: null };

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      ...initial,
      setPaired: (deviceId, label) => set({ deviceId, label, verifiedAt: Date.now() }),
      markVerified: () => set((s) => ({ ...s, verifiedAt: Date.now() })),
      logout: () => set({ ...initial }),
    }),
    {
      name: 'ccanywhere.auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        deviceId: s.deviceId,
        label: s.label,
        verifiedAt: s.verifiedAt,
      }),
    },
  ),
);

/** Reset store back to initial state. Tests only — do not call from app code. */
export function resetAuthStoreForTest(): void {
  useAuthStore.setState({ ...initial });
}
