import { useEffect, useState } from 'react';
import { EmptyState } from './ui-state/empty-state.js';
import { ErrorState } from './ui-state/error-state.js';
import { LoadingState } from './ui-state/loading-state.js';

import { Button } from '@/components/ui/button';

import { type Share, useSharesStore } from '../state/shares.js';

/**
 * "我的分享" section for /settings.
 *
 * Lists the caller's shares newest-first with copy / delete actions.
 * Delete hits `DELETE /api/share/:code` — the snapshot 立即 404 from
 * origin, but the immutable cache means any already-cached viewer can
 * still see it. The UI warning makes this clear.
 */
export function MySharesSection(): JSX.Element {
  const shares = useSharesStore((s) => s.shares);
  const loading = useSharesStore((s) => s.loading);
  const error = useSharesStore((s) => s.error);
  const fetchMyShares = useSharesStore((s) => s.fetchMyShares);
  const deleteShare = useSharesStore((s) => s.deleteShare);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    void fetchMyShares();
  }, [fetchMyShares]);

  const copy = async (url: string, code: string): Promise<void> => {
    if (
      typeof navigator === 'undefined' ||
      navigator.clipboard === undefined ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopiedCode(code);
      window.setTimeout(() => setCopiedCode(null), 2000);
    } catch {
      // ignore — surface area kept minimal in v1
    }
  };

  const remove = async (code: string): Promise<void> => {
    setBusyCode(code);
    try {
      await deleteShare(code);
    } finally {
      setBusyCode(null);
    }
  };

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">我的分享</h2>
        <span className="font-mono text-xs text-fg-muted">
          {shares.length} 项
        </span>
      </header>

      {error !== null && <ErrorState error={error} />}

      {loading && shares.length === 0 ? (
        <LoadingState />
      ) : shares.length === 0 ? (
        <EmptyState title="还没有分享。在会话列表上点 ↗ 创建。" />
      ) : (
        <ul className="space-y-2">
          {shares.map((share) => (
            <ShareRow
              key={share.code}
              share={share}
              copied={copiedCode === share.code}
              busy={busyCode === share.code}
              onCopy={() => void copy(share.url, share.code)}
              onDelete={() => void remove(share.code)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface RowProps {
  readonly share: Share;
  readonly copied: boolean;
  readonly busy: boolean;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
}

function ShareRow({
  share,
  copied,
  busy,
  onCopy,
  onDelete,
}: RowProps): JSX.Element {
  return (
    <li className="rounded-md border border-border bg-bg-elevated px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm">
          {share.projectName || share.sessionId.slice(0, 8)}
        </span>
        <span className="font-mono text-xs text-fg-muted">
          {formatExpiry(share.expiresAt)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 truncate font-mono text-xs text-fg-muted">
          {share.url}
        </code>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onCopy}
          disabled={busy}
        >
          {copied ? '已复制' : '复制'}
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
      </div>
    </li>
  );
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return '永不过期';
  const d = new Date(expiresAt);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da} 过期`;
}
