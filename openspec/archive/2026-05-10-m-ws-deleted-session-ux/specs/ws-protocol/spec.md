## ADDED Requirements

### Requirement: Close code 表

服务端发起的 WebSocket close 帧 MUST 用以下 code 表区分语义。客户端 MUST
按 code 决定是否重连或进入终态。

| code | 语义 | server 何时发 | client 行为 |
|---|---|---|---|
| `1000` | normal closure | PTY 自然 exit（cc 进程自己结束）触发的 teardown | 进入终态 `reason='cc-exit'`，MUST NOT 重连。注：`status='dead'` 帧路径已在 1000 close 之前到达，client 已 dead；这里 1000 是 follow-up |
| `1008` | policy violation / session not found | manager 在 ws upgrade 时 `manager.get(:id) === undefined`（GC 后、server 重启后、从未存在过的 id） | 进入终态 `reason='session-gone'`，MUST NOT 重连 |
| `1009` | message too big | client `bufferedAmount > 1 MiB`（backpressure） | MUST 重连（保持现行）|
| **`4001`** | **session expired** (预留给 device cookie 过期，未实施) | (未实施) | 进入终态 `reason='session-expired'`，MUST 跳 `/login`（具体由 cookie expiry feature 实现） |
| **`4002`** | session deleted | DELETE 触发的 teardown：`bundle.session.deletedAt !== null` 时的 PTY exit | 进入终态 `reason='session-deleted'`，MUST NOT 重连 |

`4xxx` 区段是 [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455#section-7.4.2)
的 application-defined 范围，无需注册；本表使用 `4001/4002` 与
[websocket.org convention](https://websocket.org/reference/close-codes/)
对齐（4001 'Session expired' 是该来源给出的示例）。

#### Scenario: 1008 触发 client 终态

- GIVEN client 重连一个已被 GC 的 sessionId
- WHEN  服务端 ws upgrade 找不到该 session 行
- THEN  服务端发 `error` 帧 `'session not found'` 后用 `1008` 关闭连接
- AND   client 进入终态 `reason='session-gone'`
- AND   client MUST NOT 启动重连退避

#### Scenario: 4002 区分 DELETE-driven close

- GIVEN session 在某 client 上 active
- WHEN  另一 client 调 `DELETE /api/sessions/:id`，触发 `markDeleted` →
        kill → cc exit → teardown
- THEN  ws teardown 路径 close code === `4002`（因 `deletedAt !== null`）
- AND   client 收到 close 后进入终态 `reason='session-deleted'`，MUST NOT 重连

#### Scenario: 1000 cc 自死保持现行

- GIVEN cc 进程自己 exit（不是被 DELETE 触发）
- WHEN  teardown 路径检查 `bundle.session.deletedAt === null`
- THEN  close code === `1000`
- AND   client 已经在 status='dead' 帧路径上 dead，1000 close 是 follow-up

#### Scenario: 1009 backpressure 仍重连

- GIVEN client 的 ws `bufferedAmount > 1 MiB`，server 主动 close `1009`
- WHEN  client 收到 close `1009`
- THEN  client MUST NOT 进入终态
- AND   client MUST 触发 scheduleReconnect 走指数退避

## MODIFIED Requirements

### Requirement: session 终结时关闭所有 client

session 触发 exit 事件时，服务端 MUST 关闭该 session 的所有 client，并
清理订阅。close code 按"Close code 表"选择：

- 若 `bundle.session.deletedAt !== null` → close code `4002 'session deleted'`
- 否则 → close code `1000 'session ended'`

#### Scenario: PTY 自死时所有 client 收到 1000

- GIVEN 一个客户端连到某 session，且该 session 未被 DELETE
- WHEN  session 的 PTY 退出
- THEN  客户端 MUST 在合理延迟内收到 close 帧，code = `1000`

#### Scenario: DELETE-driven 死亡时 client 收到 4002

- GIVEN 一个客户端连到某 session
- WHEN  另一处调 `DELETE /api/sessions/<id>` → markDeleted → kill →
        最终 PTY exit
- THEN  客户端收到 close 帧 code = `4002`
- AND   close.reason 含 'session deleted'
