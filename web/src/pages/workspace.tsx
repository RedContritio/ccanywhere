import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  NewSessionDialog,
  type CreateRequest,
} from '../components/new-session-dialog.js';
import { SessionList } from '../components/session-list.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { newIdempotencyKey } from '../api.js';
import { useAuthStore } from '../state/auth.js';
import { useSessionsStore } from '../state/sessions.js';
import { useUiStore } from '../state/ui.js';

export function WorkspacePage(): JSX.Element {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();

  const projects = useSessionsStore((s) => s.projects);
  const sessions = useSessionsStore((s) => s.sessions);
  const fetchProjects = useSessionsStore((s) => s.fetchProjects);
  const fetchSessions = useSessionsStore((s) => s.fetchSessions);
  const createSession = useSessionsStore((s) => s.createSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const sessionsError = useSessionsStore((s) => s.error);

  const currentSessionId = useUiStore((s) => s.currentSessionId);
  const selectSession = useUiStore((s) => s.selectSession);

  const label = useAuthStore((s) => s.label);
  const logout = useAuthStore((s) => s.logout);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  // Idempotency key for the in-flight create request; reset each time
  // the dialog opens so distinct user actions get distinct keys.
  const idemKeyRef = useRef<string>('');

  // Initial data load.
  useEffect(() => {
    void fetchProjects();
    void fetchSessions();
  }, [fetchProjects, fetchSessions]);

  // Sync URL → currentSessionId in the store. Also restore last selected
  // session from the persisted store when URL has no :id.
  useEffect(() => {
    if (id !== undefined) {
      if (currentSessionId !== id) selectSession(id);
      return;
    }
    if (
      currentSessionId !== null &&
      sessions.some((s) => s.id === currentSessionId && s.deletedAt === null)
    ) {
      navigate(`/workspace/${currentSessionId}`, { replace: true });
    }
  }, [id, currentSessionId, sessions, selectSession, navigate]);

  const onLogout = (): void => {
    logout();
    navigate('/login', { replace: true });
  };

  const onOpenNew = (): void => {
    idemKeyRef.current = newIdempotencyKey();
    setNewDialogOpen(true);
  };

  const onCreate = async (req: CreateRequest): Promise<void> => {
    const created = await createSession(req, idemKeyRef.current);
    navigate(`/workspace/${created.id}`);
  };

  const onDelete = async (sid: string): Promise<void> => {
    try {
      await deleteSession(sid);
      if (id === sid) navigate('/workspace', { replace: true });
    } catch {
      // store already records the error; nothing extra to do here.
    }
  };

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="header-brand">ccanywhere</div>
        <div className="header-spacer" />
        <span className="header-device">{label ?? 'unnamed'}</span>
        <ThemeToggle />
        <button type="button" className="header-logout" onClick={onLogout}>
          登出
        </button>
      </header>
      <div className="workspace-body">
        <SessionList
          sessions={sessions}
          projects={projects}
          currentId={id}
          onNew={onOpenNew}
          onDelete={(sid) => void onDelete(sid)}
        />
        <section className="terminal-pane">
          <div className="terminal-pane-empty">
            {sessionsError !== null
              ? `加载失败: ${sessionsError}`
              : id === undefined
                ? '从左侧选中一个会话，或点击 "+ 新建" 创建一个'
                : '终端将在 phase 4-4 接入（xterm.js）'}
          </div>
        </section>
      </div>
      <NewSessionDialog
        open={newDialogOpen}
        projects={projects}
        onClose={() => setNewDialogOpen(false)}
        onCreate={onCreate}
      />
    </div>
  );
}
