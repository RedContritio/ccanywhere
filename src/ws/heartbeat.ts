import type { WebSocket } from 'ws';

export interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export interface HeartbeatTarget {
  ping(): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
  off(event: 'pong', listener: () => void): unknown;
}

export function attachHeartbeat(
  sock: HeartbeatTarget,
  cfg: HeartbeatConfig,
): () => void {
  if (cfg.timeoutMs <= cfg.intervalMs) {
    throw new RangeError('heartbeat timeoutMs must be > intervalMs');
  }

  let lastPongAt = Date.now();
  const onPong = (): void => {
    lastPongAt = Date.now();
  };
  sock.on('pong', onPong);

  const timer: NodeJS.Timeout = setInterval(() => {
    if (Date.now() - lastPongAt > cfg.timeoutMs) {
      sock.terminate();
      clearInterval(timer);
      sock.off('pong', onPong);
      return;
    }
    sock.ping();
  }, cfg.intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    sock.off('pong', onPong);
  };
}

// Concrete adapter for the real ws.WebSocket, kept here so callers
// don't have to spread the import surface.
export function attachHeartbeatToWs(sock: WebSocket, cfg: HeartbeatConfig): () => void {
  return attachHeartbeat(
    {
      ping: () => sock.ping(),
      terminate: () => sock.terminate(),
      on: (event, listener) => sock.on(event, listener),
      off: (event, listener) => sock.off(event, listener),
    },
    cfg,
  );
}
