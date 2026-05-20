import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '../api.js';
import { DialogBase } from './dialog-base.js';
import { ErrorState } from './ui-state/error-state.js';
import { LoadingState } from './ui-state/loading-state.js';

export interface QuotaSnapshot {
  readonly kind: 'owner' | 'limited';
  readonly cost: { readonly limitUsd: number | null; readonly usedUsd: number };
  readonly tokens: { readonly limit: number | null; readonly used: number };
}

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Polling interval in ms; default 30 000. Override only for tests. */
  readonly pollIntervalMs?: number;
}

/**
 * #46 quota panel — limited users see live cost/tokens usage vs their
 * limit. Polls `/api/me/quota` while open (default 30s). Owner sees a
 * no-limit placeholder; limited sees two progress bars colored by
 * saturation (≥80% warning, ≥100% danger).
 *
 * Polling stops when the dialog closes — no value pulling quota data
 * the user can't see. cc-side block decisions are surfaced inside the
 * terminal (cc prints the hook's `reason` field on the next prompt);
 * the panel exists to make "how close am I?" visible BEFORE the block.
 */
export function QuotaPanel({
  open,
  onClose,
  pollIntervalMs = 30_000,
}: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const data = await api<QuotaSnapshot>('/api/me/quota');
      setSnapshot(data);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'fetch failed';
      setError(msg);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refetch();
    const timer = setInterval(() => void refetch(), pollIntervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [open, pollIntervalMs, refetch]);

  return (
    <DialogBase
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="配额"
      size="md"
      footer={
        <Button type="button" variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {error !== null ? (
        <ErrorState error={error} />
      ) : snapshot === null ? (
        <LoadingState />
      ) : snapshot.kind === 'owner' ? (
        <p className="text-sm text-fg-muted">owner 账号无配额限制。</p>
      ) : (
        <div className="space-y-4">
          <QuotaRow
            label="费用 (USD)"
            used={snapshot.cost.usedUsd}
            limit={snapshot.cost.limitUsd}
            format={(v) => `$${v.toFixed(2)}`}
          />
          <QuotaRow
            label="Tokens"
            used={snapshot.tokens.used}
            limit={snapshot.tokens.limit}
            format={(v) => v.toLocaleString()}
          />
          <p className="text-xs leading-relaxed text-fg-muted">
            配额累加自账号创建以来全部 cc 用量；超限后下一次 prompt 会被
            服务端拦截。联系管理员调整限额或换发 token。
          </p>
        </div>
      )}
    </DialogBase>
  );
}

interface RowProps {
  readonly label: string;
  readonly used: number;
  readonly limit: number | null;
  readonly format: (v: number) => string;
}

function QuotaRow({ label, used, limit, format }: RowProps): JSX.Element {
  if (limit === null) {
    return (
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-fg-muted">
          {format(used)} / 无限制
        </span>
      </div>
    );
  }
  const pct =
    limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 1000) / 10);
  const toneClass =
    pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-brand';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs text-fg-muted">
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-sm bg-border">
        <div
          className={cn('absolute inset-y-0 left-0 transition-all', toneClass)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="text-right font-mono text-xs text-fg-muted">
        {format(used)} / {format(limit)}
      </div>
    </div>
  );
}
