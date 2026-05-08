import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  NewSessionDialog,
  type CreateRequest,
} from '../components/new-session-dialog.js';
import { SessionList } from '../components/session-list.js';
import { TerminalView } from '../components/terminal.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { newIdempotencyKey } from '../api.js';
import { useAuthStore } from '../state/auth.js';
import { useSessionsStore, type SessionState } from '../state/sessions.js';
import { useUiStore } from '../state/ui.js';

type WsConnection = 'connecting' | 'connected' | 'reconnecting' | 'dead';

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
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const idemKeyRef = useRef<string>('');

  // Live status from the WS layer; a per-:id key resets it on session switch.
  const [wsConnection, setWsConnection] = useState<WsConnection>('connecting');
  const [liveSessionState, setLiveSessionState] = useState<SessionState | null>(null);

  useEffect(() => {
    void fetchProjects();
    void fetchSessions();
  }, [fetchProjects, fetchSessions]);

  // URL → store. Restore last-selected when URL has no :id.
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

  // Reset terminal status indicators when switching sessions.
  useEffect(() => {
    setWsConnection('connecting');
    setLiveSessionState(null);
  }, [id]);

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
      // store records error; nothing to do here
    }
  };

  const onWsConnected = useCallback(() => setWsConnection('connected'), []);
  const onWsReconnecting = useCallback(() => setWsConnection('reconnecting'), []);
  const onWsDead = useCallback(() => setWsConnection('dead'), []);
  const onWsStatus = useCallback((s: SessionState) => setLiveSessionState(s), []);

  const currentSession =
    id !== undefined ? sessions.find((s) => s.id === id) : undefined;
  const currentProject =
    currentSession !== undefined
      ? projects.find((p) => p.id === currentSession.projectId)
      : undefined;
  const headerStatus =
    liveSessionState ?? currentSession?.state ?? null;

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
          {sessionsError !== null && id === undefined ? (
            <div className="terminal-pane-empty">加载失败: {sessionsError}</div>
          ) : id === undefined ? (
            <div className="terminal-pane-empty">
              从左侧选中一个会话，或点击 "+ 新建" 创建一个
            </div>
          ) : currentSession === undefined ? (
            <div className="terminal-pane-empty">
              session id 不在列表中（可能已被回收）
            </div>
          ) : token === null ? (
            <div className="terminal-pane-empty">未登录</div>
          ) : (
            <>
              <div className="terminal-header">
                <span className="terminal-header-name">
                  {currentProject?.name ?? currentSession.projectId}
                </span>
                {headerStatus !== null && (
                  <span className={`session-state-chip is-${headerStatus}`}>
                    {headerStatus}
                  </span>
                )}
                {currentSession.deletedAt !== null && (
                  <span className="session-deleted-chip">已删除</span>
                )}
                <div className="header-spacer" />
                <span className={`ws-conn-chip is-${wsConnection}`}>
                  {wsConnLabel(wsConnection)}
                </span>
              </div>
              <div className="terminal-host">
                <TerminalView
                  key={currentSession.id}
                  sessionId={currentSession.id}
                  token={token}
                  onStatus={onWsStatus}
                  onConnected={onWsConnected}
                  onReconnecting={onWsReconnecting}
                  onDead={onWsDead}
                />
              </div>
            </>
          )}
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

function wsConnLabel(c: WsConnection): string {
  switch (c) {
    case 'connecting':
      return '连接中…';
    case 'connected':
      return '已连接';
    case 'reconnecting':
      return '重连中…';
    case 'dead':
      return '会话已结束';
  }
}
