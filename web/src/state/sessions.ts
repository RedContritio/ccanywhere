import { create } from 'zustand';
import { api } from '../api.js';
import { recordOp } from './ops-log.js';

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

/** Optional viewport hints for resume (frontend's current terminal size). */
export interface ResumeRequest {
  cols?: number;
  rows?: number;
  webTheme?: 'dark' | 'light';
}

interface SessionsStore {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  fetchSessions: () => Promise<void>;
  createSession: (
    req: CreateSessionRequest,
    idempotencyKey: string,
  ) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  /**
   * revive a dead-stub session. Server reuses the
   * original ccanywhere id (cc jsonl filename) so the conversation
   * continues from the prior `--resume` point.
   */
  resumeSession: (id: string, req?: ResumeRequest) => Promise<Session>;
  /** Optimistic local mark — server is source of truth. */
  markSessionDeletedLocal: (id: string) => void;
}

const initial = {
  sessions: [] as Session[],
  loading: false,
  error: null as string | null,
};

export const useSessionsStore = create<SessionsStore>((set) => ({
  ...initial,
  fetchSessions: async () => {
    set({ loading: true, error: null });
    try {
      const { sessions } = await api<{ sessions: Session[] }>('/api/sessions');
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
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
    // Capture server's distinction between 200 (resume-singleton attach to
    // existing web session) vs 201 (fresh PTY spawn), and whether the
    // idempotency cache replayed. Both signals are critical to diagnose
    // "two windows for the same resume" complaints — they differentiate
    // a missing attach (bug) from a successful attach (a tab is just
    // showing the same session.id twice).
    let meta: { status: number; replayed: boolean; stored: boolean } = {
      status: 0,
      replayed: false,
      stored: false,
    };
    const created = await api<Session>('/api/sessions', {
      method: 'POST',
      body,
      idempotencyKey,
      onMeta: (m) => {
        meta = {
          status: m.status,
          replayed: m.idempotencyReplayed,
          stored: m.idempotencyStored,
        };
      },
    });
    recordOp('session.create', {
      id: created.id,
      projectId: created.projectId,
      mode: created.mode,
      status: meta.status,
      // 200 + !replayed = server-side resume-singleton attach (same cc
      // sessionId already had an active web session; we got pointed to it)
      // 201 = fresh spawn
      // 200 + replayed = client-side idempotency replay (same Idempotency-Key
      // sent twice)
      attached: meta.status === 200 && !meta.replayed,
      idempotencyReplayed: meta.replayed,
      idempotencyStored: meta.stored,
      ...(req.mode === 'resume' && 'sessionId' in req
        ? { resumeSessionId: req.sessionId }
        : {}),
    });
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === created.id)
        ? s.sessions.map((x) => (x.id === created.id ? created : x))
        : [...s.sessions, created],
    }));
    return created;
  },
  deleteSession: async (id) => {
    await api<void>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    recordOp('session.delete', { id });
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, deletedAt: x.deletedAt ?? Date.now() } : x,
      ),
    }));
  },
  resumeSession: async (id, req) => {
    const revived = await api<Session>(
      `/api/sessions/${encodeURIComponent(id)}/resume`,
      {
        method: 'POST',
        body: req ?? {},
      },
    );
    recordOp('session.resume', { id });
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? revived : x)),
    }));
    return revived;
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
