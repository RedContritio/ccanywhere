import { create } from 'zustand';

import { api } from '../api.js';

/**
 * Share metadata as exposed by the server. `expiresAt: null` = never
 * expire (per D3 + body `ttlMs: null`).
 */
export interface Share {
  readonly code: string;
  readonly url: string;
  readonly sessionId: string;
  readonly projectName: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export interface CreateShareRequest {
  readonly sessionId: string;
  /** ttlMs in ms, or null to never expire. Omit for server default. */
  readonly ttlMs?: number | null;
}

interface SharesStore {
  shares: Share[];
  loading: boolean;
  error: string | null;
  fetchMyShares: () => Promise<void>;
  createShare: (req: CreateShareRequest) => Promise<Share>;
  deleteShare: (code: string) => Promise<void>;
}

const initial = {
  shares: [] as Share[],
  loading: false,
  error: null as string | null,
};

export const useSharesStore = create<SharesStore>((set, get) => ({
  ...initial,
  fetchMyShares: async () => {
    set({ loading: true, error: null });
    try {
      const { shares } = await api<{ shares: Share[] }>('/api/share/list');
      set({ shares, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
  createShare: async (req) => {
    const body: Record<string, unknown> = { sessionId: req.sessionId };
    if (req.ttlMs !== undefined) body['ttlMs'] = req.ttlMs;
    const res = await api<{
      code: string;
      url: string;
      expiresAt: number | null;
      createdAt: number;
    }>('/api/share', { method: 'POST', body });
    // Server doesn't echo projectName/sessionId — pull them from the
    // request + the user's known session list view if needed. The list
    // endpoint will refill all fields on next fetchMyShares.
    const share: Share = {
      code: res.code,
      url: res.url,
      sessionId: req.sessionId,
      projectName: '',
      createdAt: res.createdAt,
      expiresAt: res.expiresAt,
    };
    set((state) => ({ shares: [share, ...state.shares] }));
    return share;
  },
  deleteShare: async (code) => {
    await api(`/api/share/${encodeURIComponent(code)}`, { method: 'DELETE' });
    set({ shares: get().shares.filter((s) => s.code !== code) });
  },
}));

export function resetSharesStoreForTest(): void {
  useSharesStore.setState(initial, true);
}
