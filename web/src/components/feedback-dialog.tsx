import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../api.js';
import { collectDiag } from '../state/diag.js';
import { snapshotOps } from '../state/ops-log.js';
import { useSessionsStore } from '../state/sessions.js';
import { effectiveTheme, useUiStore } from '../state/ui.js';
import { DialogBase } from './dialog-base.js';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

type Mode =
  | { kind: 'compose' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; id: string }
  | { kind: 'error'; message: string };

export function FeedbackDialog({ open, onClose }: Props): JSX.Element {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'compose' });

  useEffect(() => {
    if (open) {
      setTitle('');
      setBody('');
      setMode({ kind: 'compose' });
    }
  }, [open]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const t = title.trim();
    if (t.length === 0) return;
    setMode({ kind: 'submitting' });
    const themeMode = useUiStore.getState().themeMode;
    const sessionIds = useSessionsStore
      .getState()
      .sessions.filter((s) => s.deletedAt === null)
      .map((s) => s.id);
    try {
      const res = await api<{ id: string }>('/api/feedback', {
        method: 'POST',
        body: {
          title: t,
          ...(body.trim().length > 0 ? { body: body.trim() } : {}),
          ops: snapshotOps(),
          diag: collectDiag({
            sessionIds,
            theme: themeMode,
            effectiveTheme: effectiveTheme(themeMode),
          }),
        },
      });
      setMode({ kind: 'submitted', id: res.id });
    } catch (err) {
      setMode({
        kind: 'error',
        message: err instanceof Error ? err.message : '提交失败',
      });
    }
  };

  const isSubmitted = mode.kind === 'submitted';
  const isSubmitting = mode.kind === 'submitting';

  return (
    <DialogBase
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="反馈"
      size="md"
      footer={
        isSubmitted ? (
          <Button type="button" onClick={onClose}>
            关闭
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="feedback-form"
              disabled={isSubmitting || title.trim().length === 0}
            >
              {isSubmitting ? '提交中…' : '提交'}
            </Button>
          </>
        )
      }
    >
      {isSubmitted ? (
        <p className="text-sm text-fg-muted">
          已收到反馈：<span className="font-mono">{mode.id}</span>
        </p>
      ) : (
        <form
          id="feedback-form"
          className="space-y-4"
          onSubmit={(e) => void submit(e)}
        >
          <div className="space-y-1.5">
            <Label htmlFor="feedback-title">标题</Label>
            <Input
              id="feedback-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="feedback-body">正文（可空）</Label>
            <Textarea
              id="feedback-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              maxLength={10_000}
              disabled={isSubmitting}
              className="font-mono"
            />
          </div>
          <p className="text-xs leading-relaxed text-fg-muted">
            提交时自动附最近 50 条操作、当前终端可见内容、浏览器与网络
            状态——便于定位。如终端正显示敏感内容请取消。
          </p>
          {mode.kind === 'error' && (
            <p className="text-sm text-danger" role="alert">
              {mode.message}
            </p>
          )}
        </form>
      )}
    </DialogBase>
  );
}
