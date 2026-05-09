import { Component, type ErrorInfo, type ReactNode } from 'react';
import { collectDiag } from '../state/diag.js';
import { recordOp, snapshotOps } from '../state/ops-log.js';
import { useSessionsStore } from '../state/sessions.js';
import { effectiveTheme, useUiStore } from '../state/ui.js';

interface Props {
  readonly children: ReactNode;
}

type Submit =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; id: string }
  | { kind: 'failed'; message: string };

interface State {
  readonly error: Error | null;
  readonly submit: Submit;
}

/**
 * App-level error boundary. Catches React rendering / lifecycle errors
 * that would otherwise unmount the whole tree (= blank screen) and
 * records them to ops-log so the next feedback submission carries the
 * trace. Provides a one-click feedback shortcut so the user doesn't
 * have to retype the error into the regular feedback dialog.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, submit: { kind: 'idle' } };
  private lastError: Error | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.lastError = error;
    recordOp('react.error', {
      message: error.message,
      stack: (error.stack ?? '').slice(0, 2000),
      componentStack: (info.componentStack ?? '').slice(0, 2000),
    });
    // Auto-submit so the user doesn't have to act on a crash they may
    // not realize is reportable. Manual «一键反馈» button stays as a
    // retry path if this attempt failed.
    void this.submitOneClick();
  }

  private reset = (): void => {
    this.lastError = null;
    this.setState({ error: null, submit: { kind: 'idle' } });
  };

  private submitOneClick = async (): Promise<void> => {
    // Read the error from getDerivedStateFromError's update directly —
    // componentDidCatch fires before state has flushed to this.state, so
    // reading this.state.error here can return null on the auto path.
    const err = this.state.error ?? this.lastError;
    if (!err) return;
    this.setState({ submit: { kind: 'submitting' } });
    const themeMode = useUiStore.getState().themeMode;
    const sessionIds = useSessionsStore
      .getState()
      .sessions.filter((s) => s.deletedAt === null)
      .map((s) => s.id);
    let diag;
    try {
      diag = collectDiag({
        sessionIds,
        theme: themeMode,
        effectiveTheme: effectiveTheme(themeMode),
      });
    } catch {
      // Diag collection itself can throw if a downstream dependency is in
      // a half-disposed state mid-crash. Better to ship the report without
      // diag than to hide the original error behind a diag-collect error.
      diag = undefined;
    }
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: (err.message || 'render crash').slice(0, 200),
          body: (err.stack ?? '').slice(0, 9000),
          ops: snapshotOps(),
          ...(diag !== undefined ? { diag } : {}),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.setState({
          submit: { kind: 'failed', message: `HTTP ${res.status} ${text}` },
        });
        return;
      }
      const data = (await res.json()) as { id: string };
      this.setState({ submit: { kind: 'submitted', id: data.id } });
    } catch (e) {
      this.setState({
        submit: {
          kind: 'failed',
          message: e instanceof Error ? e.message : 'submit failed',
        },
      });
    }
  };

  override render(): ReactNode {
    const { error, submit } = this.state;
    if (error !== null) {
      return (
        <div className="error-fallback" role="alert">
          <h2 className="error-fallback-title">前端渲染崩溃</h2>
          <p className="error-fallback-message">{error.message || '(无错误信息)'}</p>
          {submit.kind === 'submitted' ? (
            <p className="error-fallback-hint">已自动反馈：{submit.id}</p>
          ) : submit.kind === 'submitting' ? (
            <p className="error-fallback-hint">正在自动反馈…</p>
          ) : submit.kind === 'failed' ? (
            <p className="error-fallback-hint" role="alert">
              自动反馈失败：{submit.message}
            </p>
          ) : (
            <p className="error-fallback-hint">错误已记录到 ops-log。</p>
          )}
          <div className="error-fallback-actions">
            {submit.kind === 'failed' && (
              <button
                type="button"
                className="error-fallback-reset is-primary"
                onClick={() => void this.submitOneClick()}
              >
                重试反馈
              </button>
            )}
            <button
              type="button"
              className="error-fallback-reset"
              onClick={this.reset}
            >
              重试当前页
            </button>
            <button
              type="button"
              className="error-fallback-reset"
              onClick={() => location.reload()}
            >
              刷新整页
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
