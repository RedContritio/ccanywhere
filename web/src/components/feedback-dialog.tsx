import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { snapshotOps } from '../state/ops-log.js';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

type Mode =
  | { kind: 'compose' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; id: string }
  | { kind: 'error'; message: string };

export function FeedbackDialog({ open, onClose }: Props): JSX.Element | null {
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

  if (!open) return null;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const t = title.trim();
    if (t.length === 0) return;
    setMode({ kind: 'submitting' });
    try {
      const res = await api<{ id: string }>('/api/feedback', {
        method: 'POST',
        body: {
          title: t,
          // body is optional on the server; only send when non-empty so
          // the receipt JSON stays clean instead of carrying empty strings
          ...(body.trim().length > 0 ? { body: body.trim() } : {}),
          ops: snapshotOps(),
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

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
      >
        <h2 id="feedback-title" className="dialog-title">
          反馈
        </h2>

        {mode.kind === 'submitted' ? (
          <>
            <p className="dialog-hint">已收到反馈：{mode.id}</p>
            <div className="dialog-actions">
              <button type="button" className="dialog-submit" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="dialog-field">
              <span>标题</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
                autoFocus
                disabled={mode.kind === 'submitting'}
              />
            </label>
            <label className="dialog-field">
              <span>正文（可空）</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                maxLength={10_000}
                disabled={mode.kind === 'submitting'}
                className="dialog-textarea"
              />
            </label>
            <p className="dialog-hint">
              提交时自动附最近 50 条操作记录（仅 id / 类型，不含敏感内容）。
            </p>
            {mode.kind === 'error' && (
              <p className="dialog-error" role="alert">
                {mode.message}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-cancel"
                onClick={onClose}
                disabled={mode.kind === 'submitting'}
              >
                取消
              </button>
              <button
                type="submit"
                className="dialog-submit"
                disabled={mode.kind === 'submitting' || title.trim().length === 0}
              >
                {mode.kind === 'submitting' ? '提交中…' : '提交'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
