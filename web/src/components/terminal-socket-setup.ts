import { type Terminal } from '@xterm/xterm';
import { recordOp } from '../state/ops-log.js';
import type { SessionState } from '../state/sessions.js';
import { TerminalSocket, type DeadReason } from '../ws.js';
import { chunkedWrite } from './terminal-config.js';

export interface TerminalSocketHandlers {
  onStatus?: (state: SessionState) => void;
  onError?: (msg: string) => void;
  onConnected?: () => void;
  onReconnecting?: () => void;
  onDead?: (reason: DeadReason) => void;
  /** : server-side input gate rejected this turn's input. */
  onQuotaExhausted?: (reason: string) => void;
  /** : first snapshot/output frame delivered. */
  onFirstData?: () => void;
}

/**
 * Wires a TerminalSocket to xterm. onSnapshot/onOutput write directly to
 * `term`; pre-stable the placeholder visually covers the terminal so any
 * wrong-dims content from the server's fallback path is hidden until the
 * proper snapshot arrives after the stable resize. Dims state machine owns
 * the first fit + resize — onConnected here just notifies upstream.
 *
 * `getHandlers` is invoked at every event so the latest props.* callbacks
 * are picked up without rebuilding the socket on every render.
 *
 * Note: server-side input gate white-lists xterm auto-emitted focus
 * tracking sequences (`\x1b[I`/`\x1b[O`), so onQuotaExhausted only
 * fires for actual user input — no client-side filtering needed here.
 */
export function setupTerminalSocket(
  sessionId: string,
  term: Terminal,
  getHandlers: () => TerminalSocketHandlers,
): TerminalSocket {
  return new TerminalSocket(sessionId, {
    onSnapshot: (data) => {
      recordOp('term.reset', { reason: 'snapshot' });
      term.reset();
      chunkedWrite(term, data, 'snapshot');
    },
    onOutput: (data) => chunkedWrite(term, data, 'output'),
    onStatus: (state) => getHandlers().onStatus?.(state),
    onError: (msg) => {
      term.write(`\r\n\x1b[31m[ws error: ${msg}]\x1b[0m\r\n`);
      getHandlers().onError?.(msg);
    },
    onConnected: () => getHandlers().onConnected?.(),
    onReconnecting: () => getHandlers().onReconnecting?.(),
    onDead: (reason: DeadReason) => getHandlers().onDead?.(reason),
    onQuotaExhausted: (reason: string) => getHandlers().onQuotaExhausted?.(reason),
    onFirstData: () => getHandlers().onFirstData?.(),
  });
}
