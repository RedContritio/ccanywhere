import { recordOp } from './state/ops-log.js';
import type { SessionState } from './state/sessions.js';

export type ServerFrame =
  | { type: 'snapshot'; upToSeq: number; data: string }
  | { type: 'output'; seq: number; data: string }
  | { type: 'status'; state: SessionState }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export type ClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

/**
 * Why this socket entered terminal "do not reconnect" state. UI uses it
 * to pick between "会话已结束" / "会话不存在" / "已被删除" labels. See
 * openspec/specs/ws-protocol/spec.md "Close code 表".
 */
export type DeadReason =
  | 'cc-exit'           // status='dead' frame from server, then close 1000
  | 'session-gone'      // close 1008 — manager doesn't have this id
                         // (GC after ttl, server restart, never existed)
  | 'session-deleted';  // close 4002 — DELETE-driven teardown

export interface SocketHandlers {
  onSnapshot?: (data: string) => void;
  onOutput?: (data: string) => void;
  onStatus?: (state: SessionState) => void;
  onError?: (message: string) => void;
  onConnected?: () => void;
  onReconnecting?: () => void;
  onDead?: (reason: DeadReason) => void;
}

export type WebSocketFactory = (url: string) => WebSocket;

const BACKOFF_STEPS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const MAX_BACKOFF_MS = 8_000;

export interface SocketDiag {
  readonly readyState: number;
  readonly lastSeq: number;
  readonly retryIdx: number;
  readonly lastFrameTs: number;
  readonly lastFrameType: string;
}

const RECONNECT_OP_MIN_INTERVAL_MS = 1000;
const WS_CLOSED_READY_STATE = 3;

export class TerminalSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private dead = false;
  private retryIdx = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Cumulative byte count of cc output the server has acknowledged. The
   * server sends this on every output / snapshot frame; we feed it back
   * via `?lastSeq=N` on reconnect so the server knows whether to send a
   * full snapshot (lastSeq=0 or evicted) or just incremental delta.
   */
  private lastSeq = 0;
  private lastFrameTs = 0;
  private lastFrameType = '';
  private lastReconnectOpTs = 0;

  private readonly onOnline = (): void => {
    this.forceReconnect();
  };
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.forceReconnect();
  };

  constructor(
    private readonly sessionId: string,
    private readonly handlers: SocketHandlers,
    private readonly factory: WebSocketFactory = (url) => new WebSocket(url),
  ) {
    // Listen for the two signals that "the user's network situation
    // probably just got better": OS-level online event after a flap, and
    // page returning to foreground after the user backgrounded the tab.
    // Without these, the exponential backoff caps at 8s but keeps cycling
    // even after connectivity is back — the UI looks "stuck" until the
    // user reloads.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.connect();
  }

  send(frame: ClientFrame): void {
    if (this.dead || this.closed) return;
    const ws = this.ws;
    if (ws !== null && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  /**
   * Skip the current backoff window and try connecting now. Called when
   * we have an external reason to believe the network is back (browser
   * 'online' event, page visibility flipping back to 'visible'). No-op if
   * already open / closed / dead, or if the socket is mid-handshake.
   */
  private forceReconnect(): void {
    if (this.closed || this.dead) return;
    if (this.ws !== null) {
      const rs = this.ws.readyState;
      if (rs === this.ws.OPEN || rs === this.ws.CONNECTING) return;
    }
    this.retryIdx = 0;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connect();
  }

  private connect(): void {
    if (this.closed || this.dead) return;
    const url = this.buildUrl();
    const ws = this.factory(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retryIdx = 0;
      recordOp('ws.connect', { sessionId: this.sessionId });
      this.handlers.onConnected?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      let frame: ServerFrame;
      try {
        frame = JSON.parse(raw) as ServerFrame;
      } catch {
        recordOp('ws.frame.error', { reason: 'invalid_json' });
        return;
      }
      this.dispatch(frame);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      recordOp('ws.close', { code: ev.code, reason: String(ev.reason ?? '').slice(0, 200) });
      if (this.closed || this.dead) return;

      // Terminal close codes — see openspec/specs/ws-protocol/spec.md
      // "Close code 表". 1000 'cc-exit' is normally reached via the
      // status='dead' frame path which already set this.dead; the bare
      // 1000 close that follows is filtered by the (this.dead) guard
      // above. The codes here are the ones that arrive WITHOUT a prior
      // status='dead'.
      if (ev.code === 1008) {
        this.dead = true;
        this.handlers.onDead?.('session-gone');
        return;
      }
      if (ev.code === 4002) {
        this.dead = true;
        this.handlers.onDead?.('session-deleted');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // close handler will run; nothing else to do here.
    };
  }

  private dispatch(frame: ServerFrame): void {
    this.lastFrameTs = Date.now();
    this.lastFrameType = frame.type;
    switch (frame.type) {
      case 'snapshot':
        this.lastSeq = frame.upToSeq;
        this.handlers.onSnapshot?.(frame.data);
        return;
      case 'output':
        this.lastSeq = frame.seq;
        this.handlers.onOutput?.(frame.data);
        return;
      case 'status':
        if (frame.state === 'dead') {
          this.dead = true;
          this.handlers.onStatus?.(frame.state);
          this.handlers.onDead?.('cc-exit');
          this.close();
          return;
        }
        this.handlers.onStatus?.(frame.state);
        return;
      case 'error':
        this.handlers.onError?.(frame.message);
        return;
      case 'pong':
        return;
      default: {
        // Unknown frame type — log to ops once and drop. The discriminated
        // union exhaustively covers known types, so reaching this branch
        // means the server speaks a newer protocol version than we do.
        const t = (frame as { type?: string }).type;
        recordOp('ws.frame.error', { reason: 'unknown_type', type: String(t ?? '') });
      }
    }
  }

  private scheduleReconnect(): void {
    // Limit ws.reconnect ops to ≤ 1/s. The 8s backoff cap means the
    // unrate-limited path can pile up dozens of identical entries during
    // a long outage and squeeze useful older ops out of the 50-slot ring.
    const now = Date.now();
    if (now - this.lastReconnectOpTs >= RECONNECT_OP_MIN_INTERVAL_MS) {
      recordOp('ws.reconnect', { retryIdx: this.retryIdx });
      this.lastReconnectOpTs = now;
    }
    this.handlers.onReconnecting?.();
    const delay = BACKOFF_STEPS_MS[this.retryIdx] ?? MAX_BACKOFF_MS;
    this.retryIdx = Math.min(this.retryIdx + 1, BACKOFF_STEPS_MS.length - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Snapshot of internal state for feedback diag. Reads of the underlying
   * WebSocket readyState fall back to CLOSED when the socket is null.
   */
  getDiag(): SocketDiag {
    return {
      readyState: this.ws?.readyState ?? WS_CLOSED_READY_STATE,
      lastSeq: this.lastSeq,
      retryIdx: this.retryIdx,
      lastFrameTs: this.lastFrameTs,
      lastFrameType: this.lastFrameType,
    };
  }

  private buildUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Browser sends the session cookie automatically on same-origin WS
    // upgrade; no token in the URL.
    const path = `${proto}//${location.host}/ws/sessions/${encodeURIComponent(this.sessionId)}`;
    if (this.lastSeq > 0) {
      return `${path}?lastSeq=${this.lastSeq}`;
    }
    return path;
  }
}
