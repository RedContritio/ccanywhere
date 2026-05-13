import { Button } from '@/components/ui/button';

/** Right-slot icons for an active terminal session header. */
export function ActiveHeaderIcons({
  onQuota,
  onSettings,
  onReload,
}: {
  onQuota: () => void;
  onSettings: () => void;
  onReload: () => void;
}): JSX.Element {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onQuota}
        title="配额"
        aria-label="查看配额"
      >
        💰
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={onSettings}
        title="设置"
        aria-label="设置"
      >
        ⚙
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
