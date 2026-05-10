# WebSocket 协议

## Purpose

WebSocket 是数据面：把 PTY 的字节流双向送给 xterm.js，并在多 client 间广播。
协议针对 TUI（cc 用 Ink）做了 100ms 微聚合，避免每个像素一帧。

## Requirements

### Requirement: 连接路径与鉴权

WebSocket 端点 MUST 是 `GET /ws/sessions/:id`，路径参数 `:id` 是 session UUID。
鉴权按 `openspec/specs/auth/spec.md`——浏览器 WS upgrade 自动带 same-origin
HttpOnly cookie `ccanywhere_session=<id>`，服务端从 cookie 解析 device 身份。
MUST NOT 接受 `?token=` query 参数。

WS upgrade MAY 携带 `?lastSeq=N` query 参数（N 为非负整数）。N 是 cumulative
byte counter，重连时客户端反馈"上一次接收过的输出截止位置"，用于 incremental
delta 协商（详见"连接初始化序列"）。N 缺失、非整数、负数时按 0 处理。

#### Scenario: 缺 cookie 的 upgrade 失败

- GIVEN `GET /ws/sessions/anything`，请求不带 `Cookie`
- WHEN  服务端处理 upgrade
- THEN  返回 HTTP `401`
- AND   底层 socket 立即关闭

#### Scenario: 未知 sessionId 关闭

- GIVEN 合法 cookie，但 `:id` 不在 manager 中
- WHEN  WebSocket 完成升级后服务端处理
- THEN  服务端 MUST 发送 `error` 帧 `{ "type": "error", "message": "session not found" }`
- AND   随即用 close code `1008` 关闭连接

### Requirement: 客户端帧格式

客户端发往服务端的帧 MUST 是 UTF-8 JSON 文本，符合下列 discriminated union
（`type` 为判别符）：

```json
{ "type": "input",  "data": "<UTF-8 text>" }
{ "type": "resize", "cols": <int 1..1000>, "rows": <int 1..1000> }
{ "type": "ping" }
```

服务端 MUST 用 zod schema 校验。任何不符 schema 的帧——包括非 JSON、
未知 `type`、缺字段、字段越界——MUST 触发服务端回送一个 `error` 帧，
连接保持。

#### Scenario: 非 JSON 帧

- GIVEN 客户端已连接
- WHEN  发送 `not json`
- THEN  服务端 MUST 回 `{ "type": "error", "message": "invalid json" }`
- AND   连接保持

#### Scenario: 未知 type 帧

- GIVEN 客户端已连接
- WHEN  发送 `{ "type": "unknown-frame" }`
- THEN  服务端 MUST 回 `{ "type": "error", "message": "invalid frame" }`
- AND   连接保持

### Requirement: 服务端帧格式

服务端发往客户端的帧 MUST 是以下之一：

```json
{ "type": "snapshot", "upToSeq": <int>, "data": "<UTF-8 minimal-ANSI screen>" }
{ "type": "output",   "seq": <int>,     "data": "<UTF-8 since last flush>" }
{ "type": "status",   "state": "starting|idle|busy|dead" }
{ "type": "error",    "message": "<人类可读>" }
{ "type": "pong" }
```

`upToSeq` / `seq` 字段是服务端 PTY 输出的 cumulative byte counter——session
生命周期内单调递增，不因 reconnect / scrollback eviction 而重置。客户端收到
任一帧 MUST 把 `upToSeq` 或 `seq` 记为 `lastSeq`，下次 reconnect 时通过
`?lastSeq=N` 反馈给服务端。

`snapshot.data` 是当前可见 grid 的 minimal-ANSI 序列化（来自 server-side
xterm-headless + SerializeAddon，详见 `openspec/specs/sessions/spec.md` 的
"server-side 屏幕镜像"），含 cursor 位置、alt-screen 切换、当前 cell 内容；
**不是** scrollback 的 raw bytes。`output.data` 是 PTY 增量字节。

### Requirement: 连接初始化序列

升级成功后，服务端 MUST NOT 立即发 initial state——而是等待客户端的第一个
`resize` 帧。理由：服务端的 screenState (xterm-headless) 与客户端 xterm 必须
先对齐 cols/rows，再 serialize 才能让客户端按其实际显示尺寸渲染。

收到第一个 `resize` 帧后：

1. 服务端 MUST 把该 resize 同步透传到 PTY（与"resize 与多 client"一致）。
2. 服务端 MUST 等待约 200 ms（让 cc 收到 SIGWINCH 后的重画 bytes 流到
   screenState），然后按 `?lastSeq=N` 协商：
   - `lastSeq == 0`（缺失、无效或显式为 0）：发 `snapshot` 帧（data 来自
     `screenState.snapshot()`，upToSeq 取 `scrollback.headSeq`），再发
     `status` 帧。客户端 MUST 在收到 snapshot 后 reset xterm buffer 再写入。
   - `lastSeq > 0` 且 `scrollback.tailSeq < lastSeq <= scrollback.headSeq`：
     发 `output { seq: headSeq, data: scrollback.since(lastSeq) }` + `status`
     帧。客户端 MUST NOT reset xterm buffer，直接 append。
   - `lastSeq > 0` 但 `lastSeq <= scrollback.tailSeq`（数据已被 ring buffer
     FIFO 丢弃）：fallback 走 `lastSeq == 0` 路径——发 snapshot + status。
   - `since(lastSeq)` 长度为 0 时（客户端没漏任何字节）：MUST NOT 发 `output`
     帧，仅发 `status`。

若客户端 1.5 秒内未发 `resize`（兜底），服务端 MUST 用 session 当前 cols/rows
直接 serialize 并按上述 lastSeq 路径发 initial state。

#### Scenario: 新连接（无 lastSeq）首次 resize 后收 snapshot

- GIVEN session 已积累若干 PTY 输出
- WHEN  客户端通过 `/ws/sessions/:id`（不带 lastSeq）连入并发首个 resize
- THEN  在 resize 后约 200 ms，客户端按顺序收到 `snapshot { upToSeq, data }` 与 `status`
- AND   `snapshot.data` 是 minimal-ANSI（含 cursor、alt-screen、cell 内容），不是 scrollback raw bytes
- AND   `snapshot.upToSeq` 等于服务端当前 `scrollback.headSeq`

#### Scenario: 重连（lastSeq 在 ring 内）收增量 output

- GIVEN 客户端之前已 attach 过该 session，记得 `lastSeq = L > 0`
- AND   服务端 `scrollback.tailSeq < L <= scrollback.headSeq`
- WHEN  客户端用 `?lastSeq=L` 重连并发首个 resize
- THEN  客户端收到 `output { seq, data }` 帧，`data` 等于 `scrollback.since(L)`，`seq` 等于 `scrollback.headSeq`
- AND   不收 `snapshot` 帧（客户端 xterm buffer 不 reset）
- AND   随后收到 `status` 帧

#### Scenario: 重连（lastSeq 已 evict）回退 snapshot

- GIVEN 客户端用 `?lastSeq=L` 重连
- AND   服务端 `L <= scrollback.tailSeq`（数据已被 FIFO 丢弃）
- WHEN  客户端发首个 resize
- THEN  客户端收到 `snapshot` 帧（data 来自 `screenState.snapshot()`）+ `status`

#### Scenario: 重连且无字节漏失只发 status

- GIVEN 客户端用 `?lastSeq=L` 重连
- AND   服务端 `L == scrollback.headSeq`（客户端无漏失）
- WHEN  客户端发首个 resize
- THEN  客户端只收到 `status` 帧（不发 snapshot 也不发 output）

#### Scenario: 客户端不发 resize 时 1.5 秒兜底

- GIVEN 客户端连入但未发任何 resize 帧
- WHEN  超过 1.5 秒
- THEN  服务端 MUST 用当前 session cols/rows 触发 initial state（按 lastSeq 路径）

### Requirement: initial-state gating

服务端 MUST 保证客户端收到的**第一个** broadcast 帧（`snapshot` /
`output` / `status` 三类之一）来自 `sendInitialState` 路径，而非来自该
session 上其它已 attach 的 client 的实时 PTY 输出 broadcast。该约束在
"连接初始化序列" 与客户端 "snapshot 之后再 reset xterm buffer" 契约之间
建立必要 ordering。

实现 MUST 用 per-socket pending queue：

- ws upgrade 完成后，sock 加入 `bundle.clients` set 的同时 MUST 加入
  `bundle.pendingClients: Map<WebSocket, ServerFrame[]>`（空 queue）。
- 所有 broadcast 路径（PTY data flush、session status 事件）MUST 通过
  `deliver(c, frame)` 包装：若 `pendingClients` 命中则 push 到 queue，
  否则直接 send。
- `sendInitialState` 在发完 snapshot/output + status 后 MUST drain 该
  sock 的 queue：
  - 先 `pendingClients.delete(sock)` 再遍历 queue，避免 send 时同步
    异常导致残留。
  - `output` 帧若 `seq <= snapshotUpToSeq` MUST drop（snapshot/incremental
    delta 已覆盖该字节区间）。
  - `status` 帧 MUST drop（sendInitialState 末尾已发当下 session.state，
    pre-init 的 status 是过期值）。
- `sock.on('close')` MUST `pendingClients.delete(sock)`，即便 sendInitialState
  从未跑过（sock 在 1.5s 兜底之前就关闭）。

`error` / `pong` / heartbeat 帧不走 broadcast 路径（直接 `sendFrame(sock,
...)`），MUST NOT 被 gating 影响——它们要么是 init-state 之前的协议错误
反馈、要么是对端独立请求的同步响应。

#### Scenario: snapshot 是第一个 broadcast 帧

- GIVEN session 已 spawn，PTY 在 mount 时就有持续输出（如 `yes` 或 cc
  banner）
- WHEN  client connect 并发首个 resize
- THEN  client 按到达顺序记录的所有 frame 中，第一个 `snapshot` 的下标 ≤
        第一个 `output` 的下标（含相等：snapshot 与之后的 incremental
        output 都属合规第一帧候选）
- AND   `snapshot` 之前 MUST NOT 有任何 `output` 帧到达
- AND   `snapshot` 之前 MUST NOT 有任何 `status` 帧到达

#### Scenario: 多 client 独立 gate 不互扰

- GIVEN session 已 spawn，client A 已经 connect 并 sendInitialState 完成、
        正在收实时 output broadcast
- WHEN  client B connect（同 sessionId）并在发 resize 之前 PTY 出新 data
- THEN  client A 仍同步收到该 output（A 不在 pendingClients 内）
- AND   client B 在 sendInitialState 之前 MUST NOT 收到该 output（B 在
        pendingClients 内，frame buffered）
- AND   client B 收到 snapshot 之后 buffered queue 全 drop（output.seq ≤
        snapshotUpToSeq），不重复 send

#### Scenario: sock 在 init-state 之前关闭不残留 map entry

- GIVEN client connect 后立即 close（不发 resize）
- WHEN  ws server 收到 close 事件
- THEN  `bundle.pendingClients` 中 MUST NOT 留下该 sock 的 entry
- AND   1.5s fallback timer 即使 fire 也 MUST NOT 抛异常（sendInitialState
        内的 drain 在 sock 已不存在的情况下是 no-op）

#### Scenario: pre-snapshot 的 status 切换被 drain 丢

- GIVEN session 在 client connect 期间从 `starting` 转 `idle`，触发 status
        broadcast
- WHEN  client 跑完 sendInitialState
- THEN  client 收到的 status 帧 state 是 sendInitialState 调用时的当下
        session.state（即 `idle`），而非中间过渡值
- AND   pre-init 的 status 帧 MUST NOT 出现在 client 收到的帧序列中

### Requirement: 客户端→PTY 输入

收到 `input` 帧时，服务端 MUST 把 `data` 字符串原样写入 session 的 PTY，
不做转义、不做缓冲。session 处于 `dead` 时写入是 no-op。

#### Scenario: input 透传

- GIVEN 客户端已连接到一个跑 `sh` 的 session
- WHEN  客户端发 `{ "type": "input", "data": "echo cc-marker\n" }`
- THEN  客户端最终会收到一个 `output` 帧，其 `data` 包含 `cc-marker`

### Requirement: resize 与多 client

收到 `resize` 帧时，服务端 MUST 立即对 PTY 调 `resize(cols, rows)`。
多个 client attach 同一 session 时，**最后一次** resize 调用即时生效——
不做最小值/最大值聚合。

#### Scenario: resize 不阻塞后续帧

- GIVEN 客户端已连接
- WHEN  客户端依次发 `resize` 与 `ping`
- THEN  客户端会收到 `pong` 帧（resize 不影响其它帧的处理）

### Requirement: ping/pong

收到 `ping` 帧时，服务端 MUST 立即回 `{ "type": "pong" }`。
此为应用层 ping，与 WebSocket 协议层 ping 独立。

### Requirement: 输出微聚合（leading-edge + 可配 trailing fps）

服务端 MUST 用 **leading-edge** debounce 模式处理 PTY 输出。trailing 窗口
长度由 `config.outputFps` 决定（窗口 ms = `Math.round(1000 / outputFps)`），
默认 60 fps（约 17 ms）：

- 当 buffer 内**没有**定时器在跑时（即"刚从空闲恢复"），收到第一个 PTY
  data 事件 MUST **立即** 把 buffer flush 成一帧 `output`。这样用户键盘
  echo / 单字符回显**不会被微聚合的窗口期延迟**。
- 立即 flush 之后 MUST 同时启动一个 `1000 / outputFps` 毫秒的 trailing
  窗口，期间所有 PTY data 累积到 buffer；窗口到期时把累积内容统一 flush
  成一帧 `output`。trailing 窗口让 frame 速率不超过 `outputFps`，避免
  Ink TUI 高频重绘把 WebSocket 帧炸掉。
- 不论 `outputFps` 配多少，leading-edge 字节 MUST 立即可见（不等
  trailing 完成）。

session 状态变化（status 事件）或 exit 时 MUST 立即触发 flush，不留尾巴。

#### Scenario: 单字节立即可见（不被聚合窗口延迟）

- GIVEN 服务端 buffer 已为空、无定时器在跑
- WHEN  PTY 写入一个字符（例如键盘 echo）
- THEN  客户端在该字符到达后的极短时间内（毫秒级）收到一帧 `output` 含该字符

#### Scenario: 高频重绘期间帧速率被 outputFps 上限限制

- GIVEN `config.outputFps = 60`，PTY 在一帧时间（约 17 ms）内连续写入多次
- WHEN  服务端处理这些数据
- THEN  客户端最多收到 2 帧 `output`：一帧是首字节立即 leading flush，
        一帧是 trailing 窗口（约 17 ms 后）结束时把后续累积内容一次发出

#### Scenario: outputFps 调小让窗口变长

- GIVEN `config.outputFps = 24`
- WHEN  PTY 持续写入数据（超过 trailing 窗口长度）
- THEN  服务端的 trailing 窗口 MUST 约为 `Math.round(1000/24) = 42 ms`

#### Scenario: status 切换前会先 flush

- GIVEN 服务端 buffer 里还有未 flush 的 PTY 数据
- WHEN  session 触发 status 事件
- THEN  客户端 MUST 先收到一个 `output` 帧（含 buffer 里的内容），再收到 `status` 帧

### Requirement: 多 client 广播

服务端 MUST 维护每个 session 的客户端集合，所有 `output` / `status` / 关闭
事件 MUST 广播给该 session 当前的全部 client。

#### Scenario: 双 client 共收 output

- GIVEN 两个客户端 c1, c2 都连到同一 session
- WHEN  c1 发 `{type:"input", data:"echo dual\n"}`
- THEN  c1 与 c2 都最终收到一个 `output` 帧，其 `data` 包含 `dual`

### Requirement: backpressure

若某客户端 socket 的 `bufferedAmount` 超过 1 MiB，服务端 MUST 立即用 close
code `1009`（"message too big"语义）关闭该客户端，不再尝试继续发送。
其它客户端不受影响。

### Requirement: session 终结时关闭所有 client

session 触发 exit 事件时，服务端 MUST 关闭该 session 的所有 client，并
清理订阅。close code 按下面的"Close code 表"选择：

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

- GIVEN client 重连一个已被 GC / server 重启清空的 sessionId
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

#### Scenario: 1009 backpressure 仍重连

- GIVEN client 的 ws `bufferedAmount > 1 MiB`，server 主动 close `1009`
- WHEN  client 收到 close `1009`
- THEN  client MUST NOT 进入终态
- AND   client MUST 触发 scheduleReconnect 走指数退避

### Requirement: 重连语义

客户端可以多次连接同一 `:id`。每次连接 MUST 通过 `?lastSeq=N` 协商初始状态：

- `lastSeq == 0`（首次连接 / 主动 reset）→ fallback snapshot 路径。
- `lastSeq` 在 ring 内 → incremental delta 路径，客户端 xterm buffer 不 reset。
- `lastSeq` 已 evict → fallback snapshot 路径。

完整规则与 scenarios 见"连接初始化序列"。服务端不做"已连接过此 client"之类
的去重，因为没有稳定的客户端身份——`lastSeq` 不是身份，而是数据流断点。

deleted（`deletedAt !== null`）但仍存在的 session：是否允许 attach 由本规范
**不约定**，留给 M5b 决定。当前实现允许 attach（看 scrollback 历史），但
PTY 已死，input 是 no-op。

### Requirement: 服务端帧级心跳

服务端 MUST 对每个 WebSocket 客户端启动帧级 `ping`/`pong` 心跳（RFC 6455
Section 5.5.2 / 5.5.3），与应用层的 `ping`/`pong` JSON 帧独立。

服务端行为：

- 每 `wsHeartbeat.intervalMs` 毫秒调用一次 `socket.ping()`。
- 维护每连接的 `lastPongAt`，`pong` 事件触发时刷新到 `Date.now()`。
- 若 `Date.now() - lastPongAt > wsHeartbeat.timeoutMs`，MUST 立即调用
  `socket.terminate()`（直接关闭 TCP，不走 close 握手）。
- 连接关闭时 MUST 清理 interval。

客户端无需任何额外行为：浏览器 WebSocket 与 `ws` 库自动应答帧级 ping。
心跳事件 MUST NOT 暴露为应用层帧（不广播 ping/pong 到 xterm.js）。

#### Scenario: 正常心跳不踢活连接

- GIVEN 客户端按浏览器/ws 默认行为正常应答帧级 ping
- WHEN  连接持续 3 倍 `wsHeartbeat.intervalMs`
- THEN  连接保持，未被 terminate

#### Scenario: 客户端不回 pong 被踢

- GIVEN 客户端被改造为忽略所有帧级 ping（不回 pong）
- WHEN  超过 `wsHeartbeat.timeoutMs` 毫秒
- THEN  服务端 MUST 调用 `socket.terminate()`
- AND   客户端的 close 事件 code 不是 1000（非主动关闭）

#### Scenario: 心跳与应用层 pong 帧独立

- GIVEN 客户端只回应用层 `{type:"pong"}` JSON 帧但不回帧级 pong
- WHEN  超过 `wsHeartbeat.timeoutMs`
- THEN  连接仍被 terminate（应用层 pong 不刷新 `lastPongAt`）
