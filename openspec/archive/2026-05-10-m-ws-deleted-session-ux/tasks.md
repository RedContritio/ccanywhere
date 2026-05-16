# Tasks: M-ws-deleted-session-ux

## 实施 server

- [ ] T1. `src/ws/server.ts` teardown：检查 `bundle.session.deletedAt`：
  - `!== null` → `c.close(4002, 'session deleted')`
  - `=== null` → `c.close(1000, 'session ended')`（保持现行）

## 测试 server

- [ ] T2. `src/ws/server.test.ts` 加 case：
  - `'closes with 4002 when session is markDeleted-driven'`：spawn → connect →
    `session.markDeleted()` → 等 close → expect code === 4002
  - 现有 `'closes all clients when the session dies'` 改名 + 显式
    `await session.kill()`（无 markDeleted），expect code === 1000

## 实施 client

- [ ] T3. `web/src/ws.ts`：
  - 加 `type DeadReason = 'cc-exit' | 'session-gone' | 'session-deleted'`
    export
  - `SocketHandlers.onDead` 改签名 `(reason: DeadReason) => void`
  - dispatch status='dead' 传 `'cc-exit'`
  - onclose 加分支：1008 → onDead('session-gone')，4002 →
    onDead('session-deleted')，其它 → scheduleReconnect
- [ ] T4. `web/src/components/terminal.tsx`：
  - TerminalView props onDead 签名同步
  - sock.handlers.onDead 路径透传 reason
- [ ] T5. `web/src/pages/workspace.tsx`：
  - 加 `const [deadReason, setDeadReason] = useState<DeadReason | null>(null)`
  - onWsDead 接收 reason 参数：`setWsConnection('dead'); setDeadReason(reason)`
  - 切 session 时（id 变化的 useEffect）reset deadReason
  - `wsConnLabel(c, deadReason?)` 加 dead 分支 by reason

## 测试 client

- [ ] T6. `web/src/ws.test.ts` 加 case：
  - `'close code 1008 triggers onDead(session-gone), no reconnect'`
  - `'close code 4002 triggers onDead(session-deleted), no reconnect'`
  - `'close code 1006 (abnormal) still reconnects'`

## 验证

- [ ] T7. `pnpm tsc --noEmit` 干净
- [ ] T8. `pnpm vitest run` 全绿
- [ ] T9. `pnpm -C web tsc --noEmit` 干净
- [ ] T10. `pnpm -C web vitest run` 全绿
- [ ] T11. `pnpm build` + LaunchAgent kickstart，dogfood 验证：
  - server 重启后 stale tab 重连 → 看 wsConnLabel = "会话不存在"，没有
    死循环重连
  - 另一 tab DELETE 当前 session → wsConnLabel = "已被删除"

## Spec delta

- [ ] T12. `specs/ws-protocol/spec.md` 加 Requirement "Close code 表"，
  修改 "session 终结时关闭所有 client" 拆两路径。
- [ ] T13. `specs/web-frontend/spec.md` "终端视图" 段加 close code 终态
  契约。

## 应用 spec delta

- [ ] T14. 把 T12/T13 delta 合并到 `openspec/specs/`。

## 归档

- [ ] T15. `mv openspec/changes/m-ws-deleted-session-ux openspec/archive/<date>-m-ws-deleted-session-ux`
- [ ] T16. 用户确认 dogfood OK 后 commit。

## Commits

- (no matching commits found in git log)
