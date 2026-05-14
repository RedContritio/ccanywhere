import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DeadSessionSnapshot } from '../components/dead-session-pane.js';
import { EmptyPane } from '../components/empty-pane.js';
import { MobileToolbar } from '../components/mobile-toolbar.js';
import {
  ActiveHeaderIcons,
  DeadHeaderActions,
  SidebarGlobalActions,
} from '../components/workspace-header-actions.js';
import {
  NewSessionDialog,
  type CreateRequest,
} from '../components/new-session-dialog.js';
import { NotificationBanner } from '../components/notification-banner.js';
import { SessionList } from '../components/session-list.js';
import { FeedbackDialog } from '../components/feedback-dialog.js';
import { QuotaPanel } from '../components/quota-panel.js';
import { ShareCreateDialog } from '../components/share-create-dialog.js';
import { StatusBadge } from '../components/status-badge.js';
import { TerminalView, type TerminalHandle } from '../components/terminal.js';
import type { DeadReason } from '../ws.js';
import { wsConnLabel, type WsConnection } from '../ws-conn-label.js';
import { ThemeCycleButton } from '../components/theme-toggle.js';
import { logoutServer } from '../auth-flow.js';
import { useEffectiveTheme } from '../state/use-theme.js';
import { useBackgroundPoll } from '../state/use-background-poll.js';
import { useCompletionNotify } from '../state/use-completion-notify.js';
import { newIdempotencyKey } from '../api.js';
import { useAuthStore } from '../state/auth.js';
import { useActiveSessionStore } from '../state/prefs.js';
import { useProjectsStore } from '../state/projects.js';
import { useSessionsStore, type SessionState } from '../state/sessions.js';
import { useUiStore } from '../state/ui.js';

const WS_CONN_TONE: Record<WsConnection, string> = {
  connecting: 'text-fg-muted',
  connected: 'text-success',
  reconnecting: 'text-warning',
  dead: 'text-danger',
};

const STALE_REDIRECT_MS = 5000;

export function WorkspacePage(): JSX.Element {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();

  const projects = useProjectsStore((s) => s.projects);
  const sessions = useSessionsStore((s) => s.sessions);
  const fetchProjects = useProjectsStore((s) => s.fetchProjects);
  const fetchSessions = useSessionsStore((s) => s.fetchSessions);
  const createSession = useSessionsStore((s) => s.createSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const resumeSession = useSessionsStore((s) => s.resumeSession);
  const sessionsError = useSessionsStore((s) => s.error);
  const sessionsLoading = useSessionsStore((s) => s.loading);

  const currentSessionId = useUiStore((s) => s.currentSessionId);
  const selectSession = useUiStore((s) => s.selectSession);
  const remoteActiveSessionId = useActiveSessionStore((s) => s.sessionId);
  const remoteActiveLoaded = useActiveSessionStore((s) => s.loaded);
  const loadActiveSession = useActiveSessionStore((s) => s.load);
  const setRemoteActiveSession = useActiveSessionStore((s) => s.setRemote);

  const label = useAuthStore((s) => s.label);
  const deviceId = useAuthStore((s) => s.deviceId);
  const logout = useAuthStore((s) => s.logout);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [shareSessionId, setShareSessionId] = useState<string | null>(null);
  const idemKeyRef = useRef<string>('');
  const terminalRef = useRef<TerminalHandle | null>(null);

  useBackgroundPoll();
  useCompletionNotify(navigate);

  // Live status from the WS layer; a per-:id key resets it on session switch.
  const [wsConnection, setWsConnection] = useState<WsConnection>('connecting');
  // Captured when wsConnection transitions to 'dead' so the chip label can
  // distinguish cc-exit / session-gone / session-deleted (see ws-protocol
  // "Close code 表"). Reset whenever the user switches to a different
  // session or wsConnection leaves 'dead'.
  const [deadReason, setDeadReason] = useState<DeadReason | null>(null);
  const [liveSessionState, setLiveSessionState] = useState<SessionState | null>(null);

  useEffect(() => {
    void fetchProjects();
    void fetchSessions();
    void loadActiveSession();
  }, [fetchProjects, fetchSessions, loadActiveSession]);

  // URL → store, plus cross-device sync.
  //
  // When URL has :id, pick that — it's the most explicit signal (paste a
  // link, deep-link from another device). Mirror to local ui store AND
  // PUT to /api/me/active-session so the next device sees the same pick.
  //
  // When URL has no :id, prefer in order:
  //   1. local ui store's last-selected (per-tab continuity inside same browser)
  //   2. server's lastActiveSessionId (cross-device hydration; gated on
  //      remoteActiveLoaded so first paint doesn't bounce away)
  // The picked id is only honored if a live (non-deleted) session matches —
  // otherwise we land on /workspace without a session pane.
  useEffect(() => {
    if (id !== undefined) {
      if (currentSessionId !== id) selectSession(id);
      if (remoteActiveSessionId !== id) {
        void setRemoteActiveSession(id);
      }
      return;
    }
    const candidate =
      (currentSessionId !== null && currentSessionId) ||
      (remoteActiveLoaded ? remoteActiveSessionId : null);
    if (
      candidate !== null &&
      sessions.some((s) => s.id === candidate && s.deletedAt === null)
    ) {
      navigate(`/workspace/${candidate}`, { replace: true });
    }
  }, [
    id,
    currentSessionId,
    remoteActiveSessionId,
    remoteActiveLoaded,
    sessions,
    selectSession,
    setRemoteActiveSession,
    navigate,
  ]);

  // Reset terminal status indicators when switching sessions.
  useEffect(() => {
    setWsConnection('connecting');
    setDeadReason(null);
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

  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const onResume = async (sid: string): Promise<void> => {
    setResumeBusy(true);
    setResumeError(null);
    try {
      await resumeSession(sid, { webTheme: effectiveTheme });
      // Store now has the row as active; this component re-renders into
      // the TerminalView branch.
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : 'resume failed');
    } finally {
      setResumeBusy(false);
    }
  };

  const onWsConnected = useCallback(() => {
    setWsConnection('connected');
    setDeadReason(null);
  }, []);
  const onWsReconnecting = useCallback(() => setWsConnection('reconnecting'), []);
  const onWsDead = useCallback((reason: DeadReason) => {
    setWsConnection('dead');
    setDeadReason(reason);
  }, []);
  const onWsStatus = useCallback((s: SessionState) => setLiveSessionState(s), []);

  const currentSession =
    id !== undefined ? sessions.find((s) => s.id === id) : undefined;
  const currentProject =
    currentSession !== undefined
      ? projects.find((p) => p.id === currentSession.projectId)
      : undefined;
  const headerStatus =
    liveSessionState ?? currentSession?.state ?? null;
  const deadResumable =
    currentSession?.state === 'dead' && currentSession.deletedAt === null;

  // Stale URL recovery: when /workspace/<id> resolves to no live session
  // (recycled by GC, deleted in another tab, never existed), auto-bounce
  // back to /workspace after 5s so the URL doesn't sit on a permanent
  // "this session is gone" pane. Gate on !loading + no error so we don't
  // race a still-resolving fetch — the cleanup runs whenever the gate
  // flips back, cancelling the redirect if the session actually appears.
  useEffect(() => {
    if (id === undefined) return;
    if (currentSession !== undefined) return;
    if (sessionsLoading) return;
    if (sessionsError !== null) return;
    const t = setTimeout(
      () => navigate('/workspace', { replace: true }),
      STALE_REDIRECT_MS,
    );
    return () => clearTimeout(t);
  }, [id, currentSession, sessionsLoading, sessionsError, navigate]);

  // The drawer wraps the workspace header + session list on mobile. On
  // desktop it stays open inline (CSS turns the transform into a no-op).
  // Auto-close after picking a session so the terminal isn't hidden by
  // the drawer the whole time.
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    closeDrawer();
  }, [id]);

  return (
    <div
      data-workspace
      className="relative flex h-[100svh] w-full flex-row overflow-hidden bg-bg font-sans text-fg"
    >
      <aside
        className={cn(
          'flex min-h-0 w-80 shrink-0 flex-col border-r border-border bg-bg-elevated',
          // Mobile drawer: fixed overlay, slides in from left.
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-10 max-md:h-[100svh] max-md:w-[min(85vw,360px)] max-md:transform max-md:transition-transform max-md:duration-200 max-md:ease-out',
          drawerOpen
            ? 'max-md:translate-x-0'
            : 'max-md:-translate-x-full',
        )}
      >
        <header
          data-workspace-header
          className="relative z-[5] flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 max-md:flex-col max-md:items-stretch max-md:gap-2"
        >
          <button
            type="button"
            onClick={() => navigate('/workspace')}
            aria-label="返回主页"
            title="返回主页"
            className="text-sm font-semibold tracking-tight hover:text-brand"
          >
            CC anywhere
          </button>
          <div className="flex-1 max-md:hidden" />
          <div className="flex items-center gap-2 max-md:justify-between">
            <span className="truncate font-mono text-xs text-fg-muted max-md:flex-1 max-md:text-center">
              {label ?? 'unnamed'}
            </span>
            <ThemeCycleButton />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void onLogout()}
            >
              登出
            </Button>
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
        <SidebarGlobalActions
          onSettings={() => navigate('/settings')}
          onQuota={() => setQuotaOpen(true)}
          onFeedback={() => setFeedbackOpen(true)}
        />
      </aside>
      {drawerOpen && (
        <button
          type="button"
          aria-label="关闭侧边栏"
          onClick={closeDrawer}
          className="fixed inset-0 z-[9] bg-black/50 md:hidden"
        />
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        <section className="flex min-w-0 flex-1 flex-col">
          {sessionsError !== null && id === undefined ? (
            <EmptyPane onOpenDrawer={() => setDrawerOpen(true)}>
              加载失败: {sessionsError}
            </EmptyPane>
          ) : id === undefined ? (
            <EmptyPane onOpenDrawer={() => setDrawerOpen(true)}>
              <div className="flex max-w-md flex-col items-center gap-4 text-center">
                <h2 className="text-xl font-semibold tracking-tight">
                  CC anywhere
                </h2>
                <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-right text-fg-muted">设备</dt>
                  <dd className="font-mono text-fg">{label ?? 'unnamed'}</dd>
                  <dt className="text-right text-fg-muted">项目</dt>
                  <dd className="font-mono text-fg">{projects.length}</dd>
                  <dt className="text-right text-fg-muted">活跃会话</dt>
                  <dd className="font-mono text-fg">
                    {sessions.filter((s) => s.deletedAt === null).length}
                  </dd>
                </dl>
                <p className="text-xs text-fg-muted">
                  从左侧选中一个会话，或点击「+ 新建」创建一个
                </p>
              </div>
            </EmptyPane>
          ) : currentSession === undefined ? (
            sessionsLoading ? (
              <EmptyPane onOpenDrawer={() => setDrawerOpen(true)}>
                <p className="text-sm text-fg-muted">加载中…</p>
              </EmptyPane>
            ) : (
              <EmptyPane onOpenDrawer={() => setDrawerOpen(true)}>
                <div className="flex max-w-md flex-col items-center gap-4 text-center">
                  <h2 className="text-xl font-semibold tracking-tight">
                    会话已结束
                  </h2>
                  <p className="text-xs leading-relaxed text-fg-muted">
                    可以新建一个，或回到首页查看其它会话。
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={() => navigate('/workspace', { replace: true })}
                    >
                      回到首页
                    </Button>
                    <Button type="button" variant="outline" onClick={onOpenNew}>
                      新建会话
                    </Button>
                  </div>
                </div>
              </EmptyPane>
            )
          ) : deviceId === null ? (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
              未登录
            </div>
          ) : (
            <>
              <header className="relative z-[5] flex shrink-0 items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2 text-sm">
                <button
                  type="button"
                  aria-label="打开侧边栏"
                  onClick={() => setDrawerOpen(true)}
                  className="rounded-md border border-border px-2 py-1 leading-none md:hidden"
                >
                  ☰
                </button>
                <span className="truncate font-medium">
                  {currentProject?.name ?? currentSession.projectId}
                </span>
                {headerStatus !== null && (
                  <StatusBadge state={headerStatus} variant="dot" />
                )}
                {currentSession.deletedAt !== null && (
                  <span className="font-mono text-xs text-danger">已删除</span>
                )}
                <div className="flex-1" />
                {deadResumable ? (
                  <DeadHeaderActions
                    busy={resumeBusy}
                    onResume={() => void onResume(currentSession.id)}
                    onDelete={() => void onDelete(currentSession.id)}
                  />
                ) : (
                  <ActiveHeaderIcons
                    onShare={() => setShareSessionId(currentSession.id)}
                    onReload={() => location.reload()}
                  />
                )}
                <span
                  className={cn(
                    'font-mono text-xs leading-none',
                    deadResumable
                      ? 'text-fg-muted'
                      : WS_CONN_TONE[wsConnection],
                  )}
                >
                  {deadResumable
                    ? '已结束'
                    : wsConnLabel(wsConnection, deadReason)}
                </span>
              </header>
              <div
                data-pane-content
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {deadResumable ? (
                    <DeadSessionSnapshot
                      key={currentSession.id}
                      sessionId={currentSession.id}
                    />
                  ) : (
                    <TerminalView
                      key={currentSession.id}
                      ref={terminalRef}
                      sessionId={currentSession.id}
                      onStatus={onWsStatus}
                      onConnected={onWsConnected}
                      onReconnecting={onWsReconnecting}
                      onDead={onWsDead}
                    />
                  )}
                </div>
                {!deadResumable && (
                  <MobileToolbar
                    onKey={(data) => terminalRef.current?.input(data)}
                  />
                )}
              </div>
              {resumeError !== null && (
                <p
                  role="alert"
                  className="shrink-0 border-t border-border bg-bg-elevated px-3 py-2 text-xs text-danger"
                >
                  重连失败：{resumeError}
                </p>
              )}
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
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
      />
      <QuotaPanel open={quotaOpen} onClose={() => setQuotaOpen(false)} />
      <ShareCreateDialog
        open={shareSessionId !== null}
        sessionId={shareSessionId}
        projectName={
          shareSessionId === null
            ? ''
            : (projects.find(
                (p) =>
                  p.id ===
                  sessions.find((s) => s.id === shareSessionId)?.projectId,
              )?.name ??
              sessions.find((s) => s.id === shareSessionId)?.projectId ??
              '')
        }
        onClose={() => setShareSessionId(null)}
      />
    </div>
  );
}

