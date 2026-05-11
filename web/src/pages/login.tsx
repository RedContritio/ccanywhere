import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { probeSession, runLogin, runPair, runTokenLogin } from '../auth-flow.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { useAuthStore } from '../state/auth.js';

type Mode =
  | { kind: 'probing' }
  | { kind: 'idle'; suggestLogin: boolean }
  | { kind: 'pairing-create'; label: string }
  | { kind: 'pairing-await' }
  | { kind: 'logging-in' }
  | { kind: 'token-input' }
  | { kind: 'token-submitting' }
  | { kind: 'error'; message: string };

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const setPaired = useAuthStore((s) => s.setPaired);
  const setLimitedSession = useAuthStore((s) => s.setLimitedSession);
  const markVerified = useAuthStore((s) => s.markVerified);
  const logout = useAuthStore((s) => s.logout);
  const deviceId = useAuthStore((s) => s.deviceId);
  const storedKind = useAuthStore((s) => s.kind);
  const storedLabel = useAuthStore((s) => s.label);

  const [mode, setMode] = useState<Mode>({ kind: 'probing' });
  const [labelInput, setLabelInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Boot: probe existing cookie session; if it's live, go straight to /workspace.
  // probeSession returns { id, label, kind } — for owner we set paired with
  // device id, for limited we set the limited-session shape (deviceId field
  // doubles as user id; RequireAuth only cares it's non-null).
  //
  // Edge case: cookie still valid but localStorage was wiped (manual clear,
  // older client logged out before we shipped the server-side logout call,
  // etc.). probeSession returns identity even with empty store — rebuild
  // the snapshot so RequireAuth sees non-null and doesn't loop.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await probeSession();
      if (cancelled) return;
      if (me !== null) {
        if (me.kind === 'limited') setLimitedSession(me.id, me.label);
        else setPaired(me.id, me.label);
        navigate('/workspace', { replace: true });
        return;
      }
      setMode({ kind: 'idle', suggestLogin: deviceId !== null });
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, setPaired, setLimitedSession, navigate]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const onPairSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const label = labelInput.trim();
    if (label.length === 0) return;
    setMode({ kind: 'pairing-create', label });
    abortRef.current = new AbortController();
    void runPair({
      label,
      signal: abortRef.current.signal,
      onPending: () => setMode({ kind: 'pairing-await' }),
    })
      .then((r) => {
        setPaired(r.deviceId, label);
        navigate('/workspace', { replace: true });
      })
      .catch((err: unknown) => {
        setMode({
          kind: 'error',
          message: err instanceof Error ? err.message : 'pair failed',
        });
      });
  };

  const onLoginClick = (): void => {
    // Limited users don't have webauthn credentials — only owner devices
    // can run navigator.credentials.get. Defensive check; UI shouldn't
    // have presented the button anyway.
    if (deviceId === null || storedKind !== 'owner') return;
    setMode({ kind: 'logging-in' });
    void runLogin(deviceId)
      .then((ok) => {
        if (ok) {
          markVerified();
          navigate('/workspace', { replace: true });
        } else {
          // Credential miss / device revoked — wipe local state.
          logout();
          setMode({
            kind: 'error',
            message: 'login failed — device may have been revoked, please pair again',
          });
        }
      })
      .catch((err: unknown) => {
        setMode({
          kind: 'error',
          message: err instanceof Error ? err.message : 'login error',
        });
      });
  };

  const onTokenSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const t = tokenInput.trim();
    if (t.length < 32) return;
    setMode({ kind: 'token-submitting' });
    void runTokenLogin(t)
      .then((user) => {
        // We don't know the user id without another probe round-trip;
        // re-fetch /api/auth/me so the store ends up with the canonical
        // id rather than the token plaintext.
        void probeSession().then((me) => {
          if (me !== null && me.kind === 'limited') {
            setLimitedSession(me.id, me.label);
          } else {
            // Defensive: probe disagreed (shouldn't happen). Fall back to
            // setting username so RequireAuth at least sees non-null.
            setLimitedSession(user.username, user.username);
          }
          navigate('/workspace', { replace: true });
        });
      })
      .catch((err: unknown) => {
        setMode({
          kind: 'error',
          message: err instanceof Error ? err.message : 'token 登录失败',
        });
      });
  };

  const cancelPair = (): void => {
    abortRef.current?.abort();
    setMode({ kind: 'idle', suggestLogin: deviceId !== null });
  };

  return (
    <main className="login-page">
      <div className="login-page-corner">
        <ThemeToggle />
      </div>
      <div className="login-card">
        <h1 className="login-title">CC anywhere</h1>
        <p className="login-subtitle">把本地 cc 映射到 web 的远程入口</p>

        {mode.kind === 'probing' && <p className="login-hint">检查会话状态…</p>}

        {mode.kind === 'idle' && mode.suggestLogin && (
          <div className="login-form">
            <p className="login-hint">
              已配对设备
              {storedLabel !== null ? (
                <>
                  ：<strong>{storedLabel}</strong>
                </>
              ) : (
                ''
              )}
            </p>
            <button type="button" className="login-submit" onClick={onLoginClick}>
              用本机生物识别登入
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                logout();
                setMode({ kind: 'idle', suggestLogin: false });
              }}
            >
              重新配对其他设备
            </button>
          </div>
        )}

        {mode.kind === 'idle' && !mode.suggestLogin && (
          <form onSubmit={onPairSubmit} className="login-form">
            <label className="login-field">
              <span>设备名</span>
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="iPhone / 工作 mac / 朋友的笔记本"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="login-hint">
              点击「申请配对」会调用浏览器的生物识别（Touch ID / Face ID / 指纹），
              然后等待 mac 上 <code>ccanywhere approve</code> 命令通过。
            </p>
            <button
              type="submit"
              className="login-submit"
              disabled={labelInput.trim().length === 0}
            >
              申请配对
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                setTokenInput('');
                setMode({ kind: 'token-input' });
              }}
            >
              用 token 登录（受限用户）
            </button>
          </form>
        )}

        {mode.kind === 'token-input' && (
          <form onSubmit={onTokenSubmit} className="login-form">
            <label className="login-field">
              <span>Token</span>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="64 位十六进制 token"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="login-hint">
              owner 通过 mac CLI <code>ccanywhere user create</code> 或{' '}
              <code>ccanywhere token issue</code> 颁发的 plaintext token。
              限 7 天有效期。
            </p>
            <button
              type="submit"
              className="login-submit"
              disabled={tokenInput.trim().length < 32}
            >
              登录
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => setMode({ kind: 'idle', suggestLogin: deviceId !== null })}
            >
              返回
            </button>
          </form>
        )}

        {mode.kind === 'token-submitting' && (
          <p className="login-hint">正在验证 token…</p>
        )}

        {mode.kind === 'pairing-create' && (
          <p className="login-hint">请用生物识别完成「{mode.label}」的注册…</p>
        )}

        {mode.kind === 'pairing-await' && (
          <div className="login-form">
            <p className="login-hint">申请已提交，正在等待审批…</p>
            <button type="button" className="login-link" onClick={cancelPair}>
              取消
            </button>
          </div>
        )}

        {mode.kind === 'logging-in' && <p className="login-hint">正在用生物识别登入…</p>}

        {mode.kind === 'error' && (
          <div className="login-form">
            <p className="login-error" role="alert">
              {mode.message}
            </p>
            <button
              type="button"
              className="login-link"
              onClick={() => setMode({ kind: 'idle', suggestLogin: deviceId !== null })}
            >
              重试
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
