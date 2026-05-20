import type { WebSocket } from 'ws';
import { logger } from '../log.js';
import type { ServerFrame } from './protocol.js';

const MAX_BUFFERED_BYTES = 1 << 20; // 1 MB

export function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    logger.warn(
      { buffered: ws.bufferedAmount },
      'ws backpressure exceeded, closing client',
    );
    try {
      ws.close(1009, 'backpressure');
    } catch {
      // ignore
    }
    return;
  }
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    logger.warn({ err, frameType: frame.type }, 'ws send failed');
  }
}
