import { create } from 'zustand';
import { api } from '../api.js';

export interface Project {
  id: string;
  name: string;
  cwd: string;
}

export type SessionState = 'starting' | 'idle' | 'busy' | 'dead';

export interface Session {
  id: string;
  projectId: string;
  mode: 'fresh' | 'resume';
  resumeSessionId: string | null;
  state: SessionState;
  createdAt: number;
  deletedAt: number | null;
}

export interface HistorySummary {
  sessionId: string;
  modifiedAt: number;
  preview: string;
}

interface SessionsStore {
  projects: Project[];
  sessions: Session[];
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  fetchSessions: () => Promise<void>;
  fetchHistory: (projectId: string) => Promise<HistorySummary[]>;
  /** Optimistic local mark — server is source of truth. */
  markSessionDeletedLocal: (id: string) => void;
}

const initial = {
  projects: [] as Project[],
  sessions: [] as Session[],
  loading: false,
  error: null as string | null,
};

export const useSessionsStore = create<SessionsStore>((set) => ({
  ...initial,
  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const { projects } = await api<{ projects: Project[] }>('/api/projects');
      set({ projects, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
  fetchSessions: async () => {
    set({ loading: true, error: null });
    try {
      const { sessions } = await api<{ sessions: Session[] }>('/api/sessions');
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
  fetchHistory: async (projectId) => {
    const { history } = await api<{ history: HistorySummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/history`,
    );
    return history;
  },
  markSessionDeletedLocal: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, deletedAt: x.deletedAt ?? Date.now() } : x,
      ),
    })),
}));

/** Tests only. */
export function resetSessionsStoreForTest(): void {
  useSessionsStore.setState({ ...initial });
}
