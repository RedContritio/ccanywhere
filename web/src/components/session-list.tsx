import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { Project } from '../state/projects.js';
import type { Session } from '../state/sessions.js';
import { ShareCreateDialog } from './share-create-dialog.js';
import { StatusBadge } from './status-badge.js';

interface Props {
  readonly sessions: readonly Session[];
  readonly projects: readonly Project[];
  readonly currentId: string | undefined;
  readonly onNew: () => void;
  readonly onDelete: (id: string) => void;
}

/**
 * Sidebar session list. Borrows ListBase visuals (flat rows, border,
 * bg-muted selected state) but rolls its own row layout because rows need
 * a `<Link>` wrapper plus a trailing delete affordance — neither fits
 * ListBase's radiogroup/single-action shape.
 */
export function SessionList({
  sessions,
  projects,
  currentId,
  onNew,
  onDelete,
}: Props): JSX.Element {
  const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  const liveCount = sessions.filter((s) => s.deletedAt === null).length;
  const [shareId, setShareId] = useState<string | null>(null);
  const shareProj =
    shareId === null
      ? ''
      : (projects.find(
          (p) =>
            p.id === sessions.find((s) => s.id === shareId)?.projectId,
        )?.name ??
        sessions.find((s) => s.id === shareId)?.projectId ??
        '');

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-bg-elevated">
      <header className="flex items-center justify-between border-b border-border px-3.5 py-2.5 text-xs text-fg-muted">
        <span>
          会话 <span className="font-mono">({liveCount})</span>
        </span>
        <Button type="button" variant="outline" size="xs" onClick={onNew}>
          + 新建
        </Button>
      </header>
      <ul className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <li className="px-3.5 py-6 text-center text-xs text-fg-muted">
            还没有会话。点击「+ 新建」创建。
          </li>
        ) : (
          sorted.map((s) => {
            const proj = projects.find((p) => p.id === s.projectId);
            const isDeleted = s.deletedAt !== null;
            const isSelected = currentId === s.id;
            return (
              <li
                key={s.id}
                className={cn(
                  'group relative border-b border-border last:border-b-0',
                  isSelected && 'bg-bg',
                )}
              >
                <Link
                  to={`/workspace/${s.id}`}
                  className={cn(
                    'flex min-w-0 flex-col gap-1 px-3.5 py-2 text-sm transition-colors hover:bg-bg',
                    isSelected && 'text-brand',
                    isDeleted && 'opacity-50',
                  )}
                >
                  <span className="truncate">{proj?.name ?? s.projectId}</span>
                  <span className="flex items-center gap-2 text-xs">
                    <StatusBadge state={s.state} />
                    {isDeleted && (
                      <span className="font-mono text-danger">已删除</span>
                    )}
                    <span className="font-mono text-fg-muted">
                      {formatRelative(s.createdAt)}
                    </span>
                  </span>
                </Link>
                {!isDeleted && (
                  <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 transition-opacity max-md:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShareId(s.id);
                      }}
                      title="分享"
                      aria-label={`分享 ${proj?.name ?? s.projectId}`}
                      className="rounded-sm px-1.5 py-0.5 text-xs text-fg-muted transition-colors hover:text-brand"
                    >
                      ↗
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                      title="删除"
                      aria-label={`删除 ${proj?.name ?? s.projectId}`}
                      className="rounded-sm px-1.5 py-0.5 text-sm text-fg-muted transition-colors hover:text-danger"
                    >
                      ×
                    </button>
                  </div>
                )}
              </li>
            );
          })
        )}
      </ul>
      <ShareCreateDialog
        open={shareId !== null}
        sessionId={shareId}
        projectName={shareProj}
        onClose={() => setShareId(null)}
      />
    </section>
  );
}

function formatRelative(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
