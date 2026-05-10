# Proposal: M-ws-deleted-session-ux — close code 表 + client 终态停重连

## Intent

dogfood 反馈：server 重启后 client 拿 stale sessionId 重连得到 close code
1008 'session not found'，但客户端 onclose 路径 (`web/src/ws.ts:165`)
**不看 code**，统一走 `scheduleReconnect()` 走指数退避无限重连——表现
为"一直报错"。

更广义的痛点：当前 client 只把 server 帧 `status='dead'` 当终态信号，对
ws close code 完全无视。这意味着以下场景全部走"无限重连"分支：

- `1008` server 重启 / GC 后重连：sessions map 内不再有该 id
- `4002`（本 task 新引入）用户从另一 device DELETE 该 session
- `4001`（预留 #40）device cookie 过期

按 [websocket.org](https://websocket.org/reference/close-codes/) 的
application-defined 4xxx convention，4001 'Session expired' 是常见 pattern；
本 task 把 4001 留给 #40，4002 用作 'session deleted'。

## 设计要点

### close code 表

ws-protocol/spec.md 加 Requirement "close code 表"：

| code | 语义 | server 何时发 | client 行为 |
|---|---|---|---|
| `1000` | normal | PTY 自然 exit | 终态 reason='cc-exit'，停重连 |
| `1008` | session not found | manager.get(:id) === undefined（GC / restart 后） | 终态 reason='session-gone'，停重连 |
| `1009` | message too big | client `bufferedAmount > 1MiB` | 重连（保持现行）|
| **`4001`** | **(预留 #40)** session expired | cookie 过期 | 终态 reason='session-expired'，跳 /login |
| **`4002`** | session deleted | DELETE 触发的 teardown | 终态 reason='session-deleted'，停重连 |

### server-side 修改

`src/ws/server.ts:88-97` `teardown(bundle)`：

```ts
for (const c of bundle.clients) {
  try {
    if (bundle.session.deletedAt !== null) {
      c.close(4002, 'session deleted');
    } else {
      c.close(1000, 'session ended');
    }
  } catch { /* ignore */ }
}
```

teardown 路径只在 `session.on('exit', ...)` 内调；deletedAt 在 markDeleted
时已设置，markDeleted 又触发 kill → cc 收 SIGINT → exit → teardown。所以
deletedAt !== null 的判断准确反映"DELETE 触发的死亡 vs cc 自死"。

未知 sessionId 路径（`L158-160`）已经发 `1008 'session not found'`，
保留不变。

### client-side 修改

`web/src/ws.ts`：

1. SocketHandlers 接口：

```ts
type DeadReason = 'cc-exit' | 'session-gone' | 'session-deleted';

interface SocketHandlers {
  ...
  onDead?: (reason: DeadReason) => void;
}
```

2. ws.onclose (L165) 看 ev.code 决定终态 vs 重连：

```ts
ws.onclose = (ev: CloseEvent) => {
  this.ws = null;
  recordOp('ws.close', { code: ev.code, reason: ... });
  if (this.closed || this.dead) return;

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
  // 1000 (cc-exit) is reached via the status='dead' frame path which has
  // already set this.dead and called onDead('cc-exit'); the close=1000 here
  // is a follow-up that we ignore because this.dead is true.
  this.scheduleReconnect();
};
```

3. dispatch status='dead' (L189) 传 reason='cc-exit'：

```ts
case 'status':
  if (frame.state === 'dead') {
    this.dead = true;
    this.handlers.onStatus?.(frame.state);
    this.handlers.onDead?.('cc-exit');
    this.close();
    return;
  }
```

`web/src/components/terminal.tsx` TerminalHandle props 透传 onDead 签名
（reason 参数）。

`web/src/pages/workspace.tsx` wsConnection state 扩展：

- 选项 A：保留 `WsConnection` 单一 enum，加独立 `deadReason` state。
- 选项 B：union：`{ kind: 'dead'; reason: DeadReason } | 其它三态`。

推荐 A（最小侵入：现有 ws-conn-chip className、wsConnLabel 函数都用
WsConnection 字符串，扩 union 要改多处）。

`wsConnLabel(connection, reason?)` 函数对 'dead' 分支按 reason 选文案：

| reason | label |
|---|---|
| `cc-exit` | "会话已结束"（保持现状文案） |
| `session-gone` | "会话不存在"（server 重启 / GC 后） |
| `session-deleted` | "已被删除" |

### 不引入 home-card 终态切换

之前规划提过"切到 home-card UI"。重新审视：当前 workspace.tsx 已经处理
`currentSession === undefined` → home-card；但 ws close 时 currentSession
还在 sessions store（可能 sessions store 还没 refresh）。最干净的做法是
**保留 ws-conn-chip 区域显示新文案**，让用户通过 chip 知道"该 session
不能再用了"，而不是强制跳 home-card——drawer 的 session 列表会在 next
fetchSessions 后自然清掉这条 dead/deleted 行。

如果之后 dogfood 反馈"chip 不够明显"，再做 home-card 切换（独立 UX
增强 task）。

## Scope

### server-side

- `src/ws/server.ts` teardown：deletedAt → 4002 / else 1000
- `src/ws/server.test.ts` 加 case：DELETE 路径触发 4002；正常 PTY exit
  仍是 1000

### client-side

- `web/src/ws.ts` SocketHandlers + onclose + dispatch
- `web/src/ws.test.ts` 加 case：close 1008 / 4002 触发 onDead 不重连；
  其它 code 走 scheduleReconnect
- `web/src/components/terminal.tsx` props 透传
- `web/src/pages/workspace.tsx` deadReason state + wsConnLabel 分支

### spec delta

- `ws-protocol/spec.md` 加 Requirement "Close code 表"；改 "session 终结
  时关闭所有 client" 拆 PTY 自死 vs DELETE-driven 两路径
- `web-frontend/spec.md` "终端视图" 段补 close code → 终态契约

## Out of scope

- `4001` cookie 过期（→ #40）
- 终态后切 home-card UI（暂不做，wsConnLabel 文案已够用）
- backpressure (1009) close code 处理（保持现行：重连）

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 1008 / 4002 不再触发无限重连 | onclose 内显式分支 → this.dead=true，scheduleReconnect 不调用 |
| DELETE-driven close 与 PTY 自死可区分 | server teardown 看 deletedAt 选 close code；client onDead 传 reason；UI 分文案 |
| 4001 预留位不被其它 close code 占用 | spec close code 表显式列 4001='session expired (reserved #40)' |
| 现行 1000 cc-exit 行为不回归 | status='dead' 帧路径不变，onDead 加 reason 参数（默认 'cc-exit'）|
| backpressure / 网络瞬断仍走重连 | 1009 / 1006 / 1011 等不在终态分支内，fallthrough scheduleReconnect |
