import { Link } from 'react-router-dom';
import type { Project, Session } from '../state/sessions.js';

interface Props {
  readonly sessions: readonly Session[];
  readonly projects: readonly Project[];
  readonly currentId: string | undefined;
  readonly onNew: () => void;
  readonly onDelete: (id: string) => void;
}

export function SessionList({
  sessions,
  projects,
  currentId,
  onNew,
  onDelete,
}: Props): JSX.Element {
  const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  const liveCount = sessions.filter((s) => s.deletedAt === null).length;

  return (
    <aside className="session-pane">
      <div className="session-pane-header">
        <span>会话 ({liveCount})</span>
        <button type="button" className="session-new-btn" onClick={onNew}>
          + 新建
        </button>
      </div>
      <ul className="session-list">
        {sorted.length === 0 ? (
          <li className="session-list-empty">还没有会话。点击 "+ 新建" 创建。</li>
        ) : (
          sorted.map((s) => {
            const proj = projects.find((p) => p.id === s.projectId);
            const isDeleted = s.deletedAt !== null;
            const isSelected = currentId === s.id;
            const className = [
              'session-item',
              isSelected ? 'is-selected' : '',
              isDeleted ? 'is-deleted' : '',
            ]
              .filter((c) => c.length > 0)
              .join(' ');
            return (
              <li key={s.id} className={className}>
                <Link to={`/workspace/${s.id}`} className="session-item-link">
                  <div className="session-item-name">{proj?.name ?? s.projectId}</div>
                  <div className="session-item-meta">
                    <span className={`session-state-chip is-${s.state}`}>{s.state}</span>
                    {isDeleted && <span className="session-deleted-chip">已删除</span>}
                    <span className="session-created">{formatRelative(s.createdAt)}</span>
                  </div>
                </Link>
                {!isDeleted && (
                  <button
                    type="button"
                    className="session-delete-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDelete(s.id);
                    }}
                    title="删除"
                    aria-label={`删除 ${proj?.name ?? s.projectId}`}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
}

function formatRelative(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
