import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface AuthSnapshot {
  token: string | null;
  label: string | null;
  verifiedAt: number | null;
}

interface AuthStore extends AuthSnapshot {
  login: (token: string, label: string) => void;
  logout: () => void;
}

const initial: AuthSnapshot = { token: null, label: null, verifiedAt: null };

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      ...initial,
      login: (token, label) => set({ token, label, verifiedAt: Date.now() }),
      logout: () => set({ ...initial }),
    }),
    {
      name: 'ccanywhere.auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        token: s.token,
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
