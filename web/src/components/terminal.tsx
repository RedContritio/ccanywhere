import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { SessionState } from '../state/sessions.js';
import { useEffectiveTheme } from '../state/use-theme.js';
import { TerminalSocket } from '../ws.js';

interface Props {
  readonly sessionId: string;
  readonly onStatus?: (state: SessionState) => void;
  readonly onError?: (msg: string) => void;
  readonly onConnected?: () => void;
  readonly onReconnecting?: () => void;
  readonly onDead?: () => void;
}

export interface TerminalHandle {
  /** Send raw bytes to the PTY as if the user typed them. */
  input(data: string): void;
  /** Force-focus the underlying xterm. */
  focus(): void;
}

const THEMES: Record<'light' | 'dark', ITheme> = {
  dark: {
    background: '#0a0a0a',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    selectionBackground: '#3a3a3a',
  },
  light: {
    background: '#ffffff',
    foreground: '#1a1a1a',
    cursor: '#1a1a1a',
    selectionBackground: '#cfd8e3',
  },
};

const RESIZE_DEBOUNCE_MS = 100;

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  props,
  ref,
): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sockRef = useRef<TerminalSocket | null>(null);
  const handlersRef = useRef(props);
  handlersRef.current = props;
  const effective = useEffectiveTheme();
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  useImperativeHandle(
    ref,
    () => ({
      input: (data: string) => {
        sockRef.current?.send({ type: 'input', data });
      },
      focus: () => {
        termRef.current?.focus();
      },
    }),
    [],
  );

  // Mount / remount when sessionId changes; auth comes from the session cookie.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: THEMES[effectiveRef.current],
      convertEol: false,
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5_000,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new WebLinksAddon());
    term.unicode.activeVersion = '11';
    term.open(container);
    try {
      fit.fit();
    } catch {
      // ignore — fit can fail when container has no size yet
    }

    const sock: TerminalSocket = new TerminalSocket(props.sessionId, {
      onSnapshot: (data) => {
        term.reset();
        term.write(data);
      },
      onOutput: (data) => term.write(data),
      onStatus: (state) => handlersRef.current.onStatus?.(state),
      onError: (msg) => {
        term.write(`\r\n\x1b[31m[ws error: ${msg}]\x1b[0m\r\n`);
        handlersRef.current.onError?.(msg);
      },
      onConnected: () => handlersRef.current.onConnected?.(),
      onReconnecting: () => handlersRef.current.onReconnecting?.(),
      onDead: () => handlersRef.current.onDead?.(),
    });
    sockRef.current = sock;

    const inputDisposer = term.onData((data) => sock.send({ type: 'input', data }));

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const flushResize = (): void => {
      try {
        fit.fit();
      } catch {
        return;
      }
      sock.send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(flushResize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    // initial resize once mounted
    flushResize();

    return () => {
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      inputDisposer.dispose();
      sock.close();
      sockRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // Theme switching without remount.
  useEffect(() => {
    const term = termRef.current;
    if (term !== null) term.options.theme = THEMES[effective];
  }, [effective]);

  return <div ref={containerRef} className="terminal-view" />;
});
