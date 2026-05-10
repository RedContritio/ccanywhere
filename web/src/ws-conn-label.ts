import type { DeadReason } from './ws.js';

/**
 * Live ws connection state shown in the terminal-header chip. `'dead'`
 * is the terminal sink — the chip stops cycling once we land here.
 * `DeadReason` distinguishes which terminal cause hit (see
 * openspec/specs/ws-protocol/spec.md "Close code 表").
 */
export type WsConnection = 'connecting' | 'connected' | 'reconnecting' | 'dead';

export function wsConnLabel(
  c: WsConnection,
  reason: DeadReason | null,
): string {
  switch (c) {
    case 'connecting':
      return '连接中…';
    case 'connected':
      return '已连接';
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
