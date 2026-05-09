import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MobileToolbar } from '../components/mobile-toolbar.js';
import {
  NewSessionDialog,
  type CreateRequest,
} from '../components/new-session-dialog.js';
import { NotificationBanner } from '../components/notification-banner.js';
import { SessionList } from '../components/session-list.js';
import { TerminalView, type TerminalHandle } from '../components/terminal.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { logoutServer } from '../auth-flow.js';
import { useEffectiveTheme } from '../state/use-theme.js';
import { useBackgroundPoll } from '../state/use-background-poll.js';
import { useCompletionNotify } from '../state/use-completion-notify.js';
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
  const deviceId = useAuthStore((s) => s.deviceId);
  const logout = useAuthStore((s) => s.logout);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const idemKeyRef = useRef<string>('');
  const terminalRef = useRef<TerminalHandle | null>(null);

  useBackgroundPoll();
  useCompletionNotify(navigate);

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

  const onLogout = async (): Promise<void> => {
    // Clear the server-side cookie first; otherwise probeSession() on the
    // login page still sees a valid session and bounces straight back to
    // /workspace, where RequireAuth (deviceId === null) bounces it to
    // /login again — infinite loop, blank screen.
    await logoutServer();
    logout();
    navigate('/login', { replace: true });
  };

  const onOpenNew = (): void => {
    idemKeyRef.current = newIdempotencyKey();
    setNewDialogOpen(true);
  };

  const effectiveTheme = useEffectiveTheme();
  const onCreate = async (req: CreateRequest): Promise<void> => {
    const created = await createSession(
      { ...req, webTheme: effectiveTheme },
      idemKeyRef.current,
    );
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

  // The drawer wraps the workspace header + session list on mobile. On
  // desktop it stays open inline (CSS turns the transform into a no-op).
  // Auto-close after picking a session so the terminal isn't hidden by
  // the drawer the whole time.
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    closeDrawer();
  }, [id]);

  return (
    <div className={`workspace ${drawerOpen ? 'is-drawer-open' : ''}`}>
      <aside className="workspace-drawer">
        <header className="workspace-header">
          <button
            type="button"
            className="header-brand"
            onClick={() => navigate('/workspace')}
            aria-label="返回主页"
            title="返回主页"
          >
            CC anywhere
          </button>
          <div className="header-spacer" />
          <div className="header-actions">
            <span className="header-device">{label ?? 'unnamed'}</span>
            <ThemeToggle />
            <button
              type="button"
              className="header-logout"
              onClick={() => void onLogout()}
            >
              登出
            </button>
          </div>
        </header>
        <NotificationBanner />
        <SessionList
          sessions={sessions}
          projects={projects}
          currentId={id}
          onNew={onOpenNew}
          onDelete={(sid) => void onDelete(sid)}
        />
      </aside>
      <button
        type="button"
        className="workspace-backdrop"
        aria-label="关闭侧边栏"
        onClick={closeDrawer}
      />
      <main className="workspace-main">
        <section className="terminal-pane">
          {sessionsError !== null && id === undefined ? (
            <div className="terminal-pane-empty">
              <button
                type="button"
                className="terminal-hamburger"
                aria-label="打开侧边栏"
                onClick={() => setDrawerOpen(true)}
              >
                ☰
              </button>
              加载失败: {sessionsError}
            </div>
          ) : id === undefined ? (
            <div className="terminal-pane-empty">
              <button
                type="button"
                className="terminal-hamburger"
                aria-label="打开侧边栏"
                onClick={() => setDrawerOpen(true)}
              >
                ☰
              </button>
              <div className="home-card">
                <h2 className="home-title">CC anywhere</h2>
                <dl className="home-status">
                  <dt>设备</dt>
                  <dd>{label ?? 'unnamed'}</dd>
                  <dt>项目</dt>
                  <dd>{projects.length}</dd>
                  <dt>活跃会话</dt>
                  <dd>{sessions.filter((s) => s.deletedAt === null).length}</dd>
                </dl>
                <p className="home-hint">
                  从左侧选中一个会话，或点击「+ 新建」创建一个
                </p>
              </div>
            </div>
          ) : currentSession === undefined ? (
            <div className="terminal-pane-empty">
              <button
                type="button"
                className="terminal-hamburger"
                aria-label="打开侧边栏"
                onClick={() => setDrawerOpen(true)}
              >
                ☰
              </button>
              session id 不在列表中（可能已被回收）
            </div>
          ) : deviceId === null ? (
            <div className="terminal-pane-empty">未登录</div>
          ) : (
            <>
              <div className="terminal-header">
                <button
                  type="button"
                  className="terminal-hamburger"
                  aria-label="打开侧边栏"
                  onClick={() => setDrawerOpen(true)}
                >
                  ☰
                </button>
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
                  ref={terminalRef}
                  sessionId={currentSession.id}
                  onStatus={onWsStatus}
                  onConnected={onWsConnected}
                  onReconnecting={onWsReconnecting}
                  onDead={onWsDead}
                />
              </div>
              <MobileToolbar
                onKey={(data) => terminalRef.current?.input(data)}
              />
            </>
          )}
        </section>
      </main>
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
