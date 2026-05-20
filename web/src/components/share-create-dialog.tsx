import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { useSharesStore } from '../state/shares.js';
import { DialogBase } from './dialog-base.js';

interface Props {
  readonly open: boolean;
  readonly sessionId: string | null;
  readonly projectName: string;
  readonly onClose: () => void;
}

type Mode =
  | { kind: 'compose' }
  | { kind: 'submitting' }
  | { kind: 'created'; url: string; expiresAt: number | null }
  | { kind: 'error'; message: string };

type TtlOption = '1d' | '7d' | '30d' | 'never';

const TTL_MS: Record<Exclude<TtlOption, 'never'>, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const TTL_LABEL: Record<TtlOption, string> = {
  '1d': '1 天',
  '7d': '7 天',
  '30d': '30 天',
  never: '永不过期',
};

export function ShareCreateDialog({
  open,
  sessionId,
  projectName,
  onClose,
}: Props): JSX.Element {
  const [ttl, setTtl] = useState<TtlOption>('7d');
  const [mode, setMode] = useState<Mode>({ kind: 'compose' });
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const createShare = useSharesStore((s) => s.createShare);

  useEffect(() => {
    if (open) {
      setTtl('7d');
      setMode({ kind: 'compose' });
      setCopyState('idle');
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    if (sessionId === null) return;
    setMode({ kind: 'submitting' });
    try {
      const ttlMs = ttl === 'never' ? null : TTL_MS[ttl];
      const share = await createShare({ sessionId, ttlMs });
      setMode({
        kind: 'created',
        url: share.url,
        expiresAt: share.expiresAt,
      });
    } catch (err) {
      setMode({
        kind: 'error',
        message: err instanceof Error ? err.message : 'failed',
      });
    }
  };

  const copy = async (url: string): Promise<void> => {
    if (
      typeof navigator === 'undefined' ||
      navigator.clipboard === undefined ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      setCopyState('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('failed');
    }
  };

  const expiresLabel = (expiresAt: number | null): string => {
    if (expiresAt === null) return '永不过期';
    const d = new Date(expiresAt);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 过期`;
  };

  return (
    <DialogBase
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="分享会话"
      description="生成公开 URL — 任何拿到链接的人都能查看，无需登录。"
      footer={
        mode.kind === 'created' ? (
          <Button type="button" variant="default" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={mode.kind === 'submitting' || sessionId === null}
              onClick={() => void submit()}
            >
              {mode.kind === 'submitting' ? '生成中…' : '生成链接'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        <div className="text-xs text-fg-muted">
          会话: <span className="font-mono text-fg">{projectName}</span>
        </div>

        {mode.kind !== 'created' && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="share-ttl">链接有效期</Label>
              <Select
                value={ttl}
                onValueChange={(v) => setTtl(v as TtlOption)}
              >
                <SelectTrigger id="share-ttl" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['1d', '7d', '30d', 'never'] as const).map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {TTL_LABEL[opt]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              ⚠ 请确认会话内容不含密钥 / 令牌 / 私密路径后再分享。链接一旦
              生成即可被任何人访问，且因 CDN 缓存不可立即撤回。
            </div>
          </>
        )}

        {mode.kind === 'error' && (
          <p className="font-mono text-xs text-danger">
            创建失败: {mode.message}
          </p>
        )}

        {mode.kind === 'created' && (
          <div className="space-y-2">
            <Label>公开 URL</Label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={mode.url}
                className="flex-1 truncate rounded-sm border border-border bg-bg px-2 py-1 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copy(mode.url)}
              >
                {copyState === 'copied'
                  ? '已复制'
                  : copyState === 'failed'
                    ? '复制失败'
                    : '复制'}
              </Button>
            </div>
            <p className="font-mono text-xs text-fg-muted">
              {expiresLabel(mode.expiresAt)}
            </p>
          </div>
        )}
      </div>
    </DialogBase>
  );
}
