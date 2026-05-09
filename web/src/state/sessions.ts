import { create } from 'zustand';
import { api } from '../api.js';

export interface Project {
  id: string;
  name: string;
  cwd: string;
  /** epoch-ms; directory mtime on the server side. */
  modifiedAt: number;
}

export type SessionState = 'starting' | 'idle' | 'busy' | 'dead';

export interface Session {
  id: string;
  projectId: string;
  mode: 'create' | 'resume';
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

export interface CreateSessionRequest {
  projectId: string;
  mode: 'create' | 'resume';
  sessionId?: string;
  /**
   * Hint to the server which color scheme the cc TUI should use (cc reads
   * `COLORFGBG` when its `theme` setting is `"auto"`). Captured at create
   * time only — runtime web-side theme switches don't propagate to a
   * running cc process.
   */
  webTheme?: 'dark' | 'light';
}

interface SessionsStore {
  projects: Project[];
  sessions: Session[];
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  fetchSessions: () => Promise<void>;
  fetchHistory: (projectId: string) => Promise<HistorySummary[]>;
  createSession: (req: CreateSessionRequest, idempotencyKey: string) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  /** Optimistic local mark — server is source of truth. */
  markSessionDeletedLocal: (id: string) => void;
  /** Create a new project subdir under the server's projectsRoot. */
  createProject: (name: string) => Promise<Project>;
  /** Hide a project (server-side soft-delete; directory remains on disk). */
  hideProject: (id: string) => Promise<void>;
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
  createSession: async (req, idempotencyKey) => {
    const themeHint =
      req.webTheme !== undefined ? { webTheme: req.webTheme } : {};
    const body =
      req.mode === 'resume'
        ? {
            projectId: req.projectId,
            mode: req.mode,
            sessionId: req.sessionId,
            ...themeHint,
          }
        : { projectId: req.projectId, mode: req.mode, ...themeHint };
    const created = await api<Session>('/api/sessions', {
      method: 'POST',
      body,
      idempotencyKey,
    });
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === created.id)
        ? s.sessions.map((x) => (x.id === created.id ? created : x))
        : [...s.sessions, created],
    }));
    return created;
  },
  deleteSession: async (id) => {
    await api<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, deletedAt: x.deletedAt ?? Date.now() } : x,
      ),
    }));
  },
  markSessionDeletedLocal: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, deletedAt: x.deletedAt ?? Date.now() } : x,
      ),
    })),
  createProject: async (name) => {
    const created = await api<Project>('/api/projects', {
      method: 'POST',
      body: { name },
    });
    set((s) => ({
      projects: s.projects.some((p) => p.id === created.id)
        ? s.projects
        : [...s.projects, created].sort((a, b) => a.id.localeCompare(b.id)),
    }));
    return created;
  },
  hideProject: async (id) => {
    await api<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },
}));

/** Tests only. */
export function resetSessionsStoreForTest(): void {
  useSessionsStore.setState({ ...initial });
}
