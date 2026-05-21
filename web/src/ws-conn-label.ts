import type { DeadReason } from './ws.js';

/**
 * Live ws connection state shown in the terminal-header chip. `'dead'`
 * is the terminal sink — the chip stops cycling once we land here.
 * `DeadReason` distinguishes which terminal cause hit (see the
 * `DeadReason` union in `ws.ts`).
 */
export type WsConnection = 'connecting' | 'connected' | 'reconnecting' | 'dead';

export function wsConnLabel(
  c: WsConnection,
  reason: DeadReason | null,
  awaitingData?: boolean,
): string {
  switch (c) {
    case 'connecting':
      return '连接中…';
    case 'connected':
      // WS upgrade succeeds before cc reloads jsonl
      // and pushes first PTY data, especially on slow networks. Without
      // this branch the chip says "已连接" while the terminal is blank.
      return awaitingData === true ? '已连接，等待 cc 输出…' : '已连接';
    case 'reconnecting':
      return '重连中…';
    case 'dead':
      switch (reason) {
        case 'session-gone':
          return '会话不存在';
        case 'session-deleted':
          return '已被删除';
        case 'cc-exit':
        case null:
          return '会话已结束';
      }
  }
}
