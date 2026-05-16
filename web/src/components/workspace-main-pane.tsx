import { useCallback, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import { DeadSessionSnapshot } from './dead-session-pane.js';
import { EmptyPane } from './empty-pane.js';
import { MobileToolbar } from './mobile-toolbar.js';
import { StatusBadge } from './status-badge.js';
import { TerminalView, type TerminalHandle } from './terminal.js';
import {
  ActiveHeaderIcons,
  DeadHeaderActions,
} from './workspace-header-actions.js';
import type { Project } from '../state/projects.js';
import type { Session, SessionState } from '../state/sessions.js';
import type { DeadReason } from '../ws.js';
import { wsConnLabel, type WsConnection } from '../ws-conn-label.js';

const WS_CONN_TONE: Record<WsConnection, string> = {
  connecting: 'text-fg-muted',
  connected: 'text-success',
  reconnecting: 'text-warning',
  dead: 'text-danger',
};

interface Props {
  /** URL :id param. undefined means /workspace home. */
  readonly id: string | undefined;
  /** Resolved session for `id`, or undefined when looking up. */
  readonly currentSession: Session | undefined;
  /** Project metadata for currentSession.projectId. */
  readonly currentProject: Project | undefined;
  /** sessions store async status. */
  readonly sessionsLoading: boolean;
  readonly sessionsError: string | null;
  /** Auth gate: null → render "未登录" branch. */
  readonly deviceId: string | null;
  /** Sidebar/home stats. */
  readonly label: string | null;
  readonly projectCount: number;
  readonly activeSessionCount: number;
  /** Open the mobile sidebar drawer. */
  readonly onOpenDrawer: () => void;
  /** Open the new-session dialog (parent owns dialog state). */
  readonly onOpenNew: () => void;
  /** Delete a session (parent handles navigate-away if id matches). */
  readonly onDelete: (sid: string) => Promise<void>;
  /** Resume a dead session into live state. */
  readonly onResume: (sid: string) => Promise<void>;
  /** Open the share-create dialog (parent owns dialog state). */
  readonly onOpenShare: (sid: string) => void;
  /** Server input-gate dropped this turn (m-quota-inline). */
  readonly onQuotaExhausted: (reason: string) => void;
}

/**
 * Workspace main pane — 5-branch renderer extracted from workspace.tsx
 * (m-workspace-page-split). Self-contained: owns WS connection state +
 * resume state + the terminal ref the mobile toolbar dispatches into.
 * Parent only threads through URL state, sessions / projects metadata,
 * and event callbacks for things that escape the pane (dialogs / navigate).
 */
export function WorkspaceMainPane({
  id,
  currentSession,
  currentProject,
  sessionsLoading,
  sessionsError,
  deviceId,
  label,
  projectCount,
  activeSessionCount,
  onOpenDrawer,
  onOpenNew,
  onDelete,
  onResume,
  onOpenShare,
  onQuotaExhausted,
}: Props): JSX.Element {
  const navigate = useNavigate();
  const terminalRef = useRef<TerminalHandle | null>(null);

  // WS layer state — local to this pane, reset on session switch via
  // the TerminalView `key={currentSession.id}` remount path.
  const [wsConnection, setWsConnection] = useState<WsConnection>('connecting');
  const [deadReason, setDeadReason] = useState<DeadReason | null>(null);
  const [liveSessionState, setLiveSessionState] = useState<SessionState | null>(null);
  const [awaitingFirstData, setAwaitingFirstData] = useState(true);

  // Reset WS indicators when switching to a different :id.
  // (Same pattern as the original workspace.tsx useEffect on [id].)
  const lastIdRef = useRef(id);
  if (lastIdRef.current !== id) {
    lastIdRef.current = id;
    setWsConnection('connecting');
    setDeadReason(null);
    setLiveSessionState(null);
    setAwaitingFirstData(true);
  }

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
  const onWsFirstData = useCallback(() => setAwaitingFirstData(false), []);

  // Resume state — local to this pane; error surfaces under terminal.
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const handleResume = async (sid: string): Promise<void> => {
    setResumeBusy(true);
    setResumeError(null);
    try {
      await onResume(sid);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : 'resume failed');
    } finally {
      setResumeBusy(false);
    }
  };

  const headerStatus = liveSessionState ?? currentSession?.state ?? null;
  const deadResumable =
    currentSession?.state === 'dead' && currentSession.deletedAt === null;

  if (sessionsError !== null && id === undefined) {
    return (
      <EmptyPane onOpenDrawer={onOpenDrawer}>加载失败: {sessionsError}</EmptyPane>
    );
  }
  if (id === undefined) {
    return (
      <EmptyPane onOpenDrawer={onOpenDrawer}>
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <h2 className="text-xl font-semibold tracking-tight">
            <span className="text-claude">CC</span> anywhere
          </h2>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
            <dt className="text-right text-fg-muted">设备</dt>
            <dd className="font-mono text-fg">{label ?? 'unnamed'}</dd>
            <dt className="text-right text-fg-muted">项目</dt>
            <dd className="font-mono text-fg">{projectCount}</dd>
            <dt className="text-right text-fg-muted">活跃会话</dt>
            <dd className="font-mono text-fg">{activeSessionCount}</dd>
          </dl>
          <p className="text-xs text-fg-muted">
            从左侧选中一个会话，或点击「+ 新建」创建一个
          </p>
        </div>
      </EmptyPane>
    );
  }
  if (currentSession === undefined) {
    if (sessionsLoading) {
      return (
        <EmptyPane onOpenDrawer={onOpenDrawer}>
          <p className="text-sm text-fg-muted">加载中…</p>
        </EmptyPane>
      );
    }
    return (
      <EmptyPane onOpenDrawer={onOpenDrawer}>
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <h2 className="text-xl font-semibold tracking-tight">会话不存在</h2>
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
    );
  }
  if (deviceId === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        未登录
      </div>
    );
  }
  return (
    <>
      <header className="relative z-[5] flex shrink-0 items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2 text-sm">
        <button
          type="button"
          aria-label="打开侧边栏"
          onClick={onOpenDrawer}
          className="rounded-md border border-border px-2 py-1 leading-none md:hidden"
        >
          <Menu className="h-4 w-4" />
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
            onResume={() => void handleResume(currentSession.id)}
            onDelete={() => void onDelete(currentSession.id)}
          />
        ) : (
          <ActiveHeaderIcons
            onShare={() => onOpenShare(currentSession.id)}
            onReload={() => location.reload()}
          />
        )}
        <span
          className={cn(
            'font-mono text-xs leading-none',
            deadResumable ? 'text-fg-muted' : WS_CONN_TONE[wsConnection],
          )}
        >
          {deadResumable
            ? '已结束'
            : wsConnLabel(wsConnection, deadReason, awaitingFirstData)}
        </span>
      </header>
      <div data-pane-content className="flex min-h-0 flex-1 flex-col">
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
              onFirstData={onWsFirstData}
              onQuotaExhausted={onQuotaExhausted}
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
  );
}
