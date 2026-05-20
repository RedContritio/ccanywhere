import { Button } from '@/components/ui/button';

/**
 * Right-slot icons for an active terminal session header. Only contextual
 * (per-current-session) actions live here — global config (settings,
 * quota) moved to the sidebar in .
 */
export function ActiveHeaderIcons({
  onShare,
  onReload,
}: {
  onShare: () => void;
  onReload: () => void;
}): JSX.Element {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onShare}
        title="分享当前 session"
        aria-label="分享当前 session"
      >
        ↗
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onReload}
        title="重连当前 session（清掉 cc Ink scrollback 累积的重复内容）"
        aria-label="刷新页面"
      >
        ↻
      </Button>
    </>
  );
}

/**
 * Sidebar bottom row: global config entrypoints (settings / quota /
 * feedback). Sits below the session list — these are user-level, not
 * tied to any current session.  moved them out
 * of the topbar so per-session and global actions are visually split.
 */
export function SidebarGlobalActions({
  onSettings,
  onQuota,
  onFeedback,
}: {
  onSettings: () => void;
  onQuota: () => void;
  onFeedback: () => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-1 border-t border-border p-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onSettings}
        title="设置"
        aria-label="设置"
      >
        ⚙ 设置
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onQuota}
        title="查看配额"
        aria-label="查看配额"
      >
        💰 配额
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onFeedback}
        title="反馈"
        aria-label="反馈"
      >
        💬 反馈
      </Button>
    </div>
  );
}

/** Right-slot actions when the terminal pane shows a dead-stub session. */
export function DeadHeaderActions({
  busy,
  onResume,
  onDelete,
}: {
  busy: boolean;
  onResume: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <>
      <Button
        type="button"
        variant="default"
        size="xs"
        onClick={onResume}
        disabled={busy}
        title="重启 cc 并接续上次对话"
      >
        {busy ? '正在重连…' : 'Resume'}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onDelete}
        disabled={busy}
      >
        删除
      </Button>
    </>
  );
}
