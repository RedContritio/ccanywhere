import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <main className="relative grid min-h-screen place-items-center bg-bg px-4 py-8 font-sans text-fg">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-bg-elevated p-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">CC anywhere</h1>
          <p className="text-xs text-fg-muted">
            把本地 cc 映射到 web 的远程入口
          </p>
        </header>

        {mode.kind === 'probing' && <Hint>检查会话状态…</Hint>}

        {mode.kind === 'idle' && mode.suggestLogin && (
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">
              已配对设备
              {storedLabel !== null && (
                <>
                  ：<span className="font-mono text-fg">{storedLabel}</span>
                </>
              )}
            </p>
            <Button type="button" className="w-full" onClick={onLoginClick}>
              用本机生物识别登入
            </Button>
            <LinkButton
              onClick={() => {
                logout();
                setMode({ kind: 'idle', suggestLogin: false });
              }}
            >
              重新配对其他设备
            </LinkButton>
          </div>
        )}

        {mode.kind === 'idle' && !mode.suggestLogin && (
          <form onSubmit={onPairSubmit} className="space-y-4">
            <Field>
              <Label htmlFor="login-label">设备名</Label>
              <Input
                id="login-label"
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="iPhone / 工作 mac / 朋友的笔记本"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Hint>
              点击「申请配对」会调用浏览器的生物识别（Touch ID / Face ID /
              指纹），然后等待 mac 上{' '}
              <Code>ccanywhere approve</Code> 命令通过。
            </Hint>
            <Button
              type="submit"
              className="w-full"
              disabled={labelInput.trim().length === 0}
            >
              申请配对
            </Button>
            <LinkButton
              onClick={() => {
                setTokenInput('');
                setMode({ kind: 'token-input' });
              }}
            >
              用 token 登录（受限用户）
            </LinkButton>
          </form>
        )}

        {mode.kind === 'token-input' && (
          <form onSubmit={onTokenSubmit} className="space-y-4">
            <Field>
              <Label htmlFor="login-token">Token</Label>
              <Input
                id="login-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="64 位十六进制 token"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Hint>
              owner 通过 mac CLI <Code>ccanywhere user create</Code> 或{' '}
              <Code>ccanywhere token issue</Code> 颁发的 plaintext token。
              限 7 天有效期。
            </Hint>
            <Button
              type="submit"
              className="w-full"
              disabled={tokenInput.trim().length < 32}
            >
              登录
            </Button>
            <LinkButton
              onClick={() =>
                setMode({ kind: 'idle', suggestLogin: deviceId !== null })
              }
            >
              返回
            </LinkButton>
          </form>
        )}

        {mode.kind === 'token-submitting' && <Hint>正在验证 token…</Hint>}

        {mode.kind === 'pairing-create' && (
          <Hint>
            请用生物识别完成「
            <span className="font-mono text-fg">{mode.label}</span>
            」的注册…
          </Hint>
        )}

        {mode.kind === 'pairing-await' && (
          <div className="space-y-3">
            <Hint>申请已提交，正在等待审批…</Hint>
            <LinkButton onClick={cancelPair}>取消</LinkButton>
          </div>
        )}

        {mode.kind === 'logging-in' && <Hint>正在用生物识别登入…</Hint>}

        {mode.kind === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-danger" role="alert">
              {mode.message}
            </p>
            <LinkButton
              onClick={() =>
                setMode({ kind: 'idle', suggestLogin: deviceId !== null })
              }
            >
              重试
            </LinkButton>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="space-y-1.5">{children}</div>;
}

function Hint({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="text-xs leading-relaxed text-fg-muted">{children}</p>
  );
}

function Code({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <code className="rounded-sm bg-bg px-1 py-0.5 font-mono text-[11px] text-fg">
      {children}
    </code>
  );
}

function LinkButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-center text-xs text-fg-muted underline-offset-4 hover:text-fg hover:underline"
    >
      {children}
    </button>
  );
}
