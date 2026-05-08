import type { SessionState } from './state/sessions.js';

export type ServerFrame =
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'status'; state: SessionState }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export type ClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export interface SocketHandlers {
  onSnapshot?: (data: string) => void;
  onOutput?: (data: string) => void;
  onStatus?: (state: SessionState) => void;
  onError?: (message: string) => void;
  onConnected?: () => void;
  onReconnecting?: () => void;
  onDead?: () => void;
}

export type WebSocketFactory = (url: string) => WebSocket;

const BACKOFF_STEPS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const MAX_BACKOFF_MS = 8_000;

export class TerminalSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private dead = false;
  private retryIdx = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly handlers: SocketHandlers,
    private readonly factory: WebSocketFactory = (url) => new WebSocket(url),
  ) {
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

  private connect(): void {
    if (this.closed || this.dead) return;
    const url = this.buildUrl();
    const ws = this.factory(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retryIdx = 0;
      this.handlers.onConnected?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      let frame: ServerFrame;
      try {
        frame = JSON.parse(raw) as ServerFrame;
      } catch {
        return;
      }
      this.dispatch(frame);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closed || this.dead) return;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // close handler will run; nothing else to do here.
    };
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame.type) {
      case 'snapshot':
        this.handlers.onSnapshot?.(frame.data);
        return;
      case 'output':
        this.handlers.onOutput?.(frame.data);
        return;
      case 'status':
        if (frame.state === 'dead') {
          this.dead = true;
          this.handlers.onStatus?.(frame.state);
          this.handlers.onDead?.();
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
    }
  }

  private scheduleReconnect(): void {
    this.handlers.onReconnecting?.();
    const delay = BACKOFF_STEPS_MS[this.retryIdx] ?? MAX_BACKOFF_MS;
    this.retryIdx = Math.min(this.retryIdx + 1, BACKOFF_STEPS_MS.length - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private buildUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Browser sends the session cookie automatically on same-origin WS
    // upgrade; no token in the URL.
    return `${proto}//${location.host}/ws/sessions/${encodeURIComponent(this.sessionId)}`;
  }
}
