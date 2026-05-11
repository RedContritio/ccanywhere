import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

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
 * #46 quota panel — limited users see live cost/tokens usage vs their limit.
 * Opens via the workspace header quota button. Polls `/api/me/quota` while
 * open (default 30s). Owner sees a no-limit placeholder; limited sees two
 * progress bars colored by saturation (≥80% yellow, ≥100% red).
 *
 * Polling stops when the dialog closes — there's no value pulling quota
 * data the user can't see. cc-side block decisions are surfaced inside the
 * terminal (cc prints the hook's `reason` field on the next prompt); the
 * panel exists to make "how close am I?" visible BEFORE the block.
 */
export function QuotaPanel({ open, onClose, pollIntervalMs = 30_000 }: Props): JSX.Element | null {
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

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog quota-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quota-title"
      >
        <h2 id="quota-title" className="dialog-title">
          配额
        </h2>
        {error !== null ? (
          <p className="dialog-hint dialog-error">加载失败：{error}</p>
        ) : snapshot === null ? (
          <p className="dialog-hint">载入中…</p>
        ) : snapshot.kind === 'owner' ? (
          <p className="dialog-hint">owner 账号无配额限制。</p>
        ) : (
          <div className="quota-body">
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
            <p className="quota-footnote">
              配额累加自账号创建以来全部 cc 用量；超限后下一次 prompt 会被服务端拦截。
              联系管理员调整限额或换发 token。
            </p>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-submit" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
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
      <div className="quota-row">
        <div className="quota-row-label">{label}</div>
        <div className="quota-row-value">{format(used)} / 无限制</div>
      </div>
    );
  }
  const pct = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 1000) / 10);
  const tone = pct >= 100 ? 'is-exhausted' : pct >= 80 ? 'is-warn' : 'is-ok';
  return (
    <div className="quota-row">
      <div className="quota-row-label">
        {label}
        <span className="quota-row-pct">{pct.toFixed(1)}%</span>
      </div>
      <div className={`quota-bar ${tone}`}>
        <div className="quota-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="quota-row-value">
        {format(used)} / {format(limit)}
      </div>
    </div>
  );
}
