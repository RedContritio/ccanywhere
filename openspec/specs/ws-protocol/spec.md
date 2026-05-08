# WebSocket 协议

## Purpose

WebSocket 是数据面：把 PTY 的字节流双向送给 xterm.js，并在多 client 间广播。
协议针对 TUI（cc 用 Ink）做了 100ms 微聚合，避免每个像素一帧。

## Requirements

### Requirement: 连接路径与鉴权

WebSocket 端点 MUST 是 `GET /ws/sessions/:id`，路径参数 `:id` 是 session UUID。
鉴权按 `openspec/specs/auth/spec.md`——用户 token 通过 `?token=` 传入
（移动端浏览器 WS API 不能自定义 header，query 串是实际选择）。

#### Scenario: 缺 token 的 upgrade 失败

- GIVEN `GET /ws/sessions/anything`，无 token
- WHEN  服务端处理 upgrade
- THEN  返回 HTTP `401`
- AND   底层 socket 立即关闭

#### Scenario: 未知 sessionId 关闭

- GIVEN 合法 token，但 `:id` 不在 manager 中
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
{ "type": "snapshot", "data": "<UTF-8 scrollback>" }
{ "type": "output",   "data": "<UTF-8 since last flush>" }
{ "type": "status",   "state": "starting|idle|busy|dead" }
{ "type": "error",    "message": "<人类可读>" }
{ "type": "pong" }
```

### Requirement: 连接初始化序列

升级成功后，服务端 MUST 在 handler 入口同步发送：

1. `snapshot` 帧，data 为当前 `session.scrollback.snapshot()`。
2. `status` 帧，state 为 `session.state`。

这两帧 MUST 在客户端接收任何 `output` 之前到达。客户端因此可以通过 snapshot
全量重建 xterm.js 状态，无需依赖增量回放。

#### Scenario: 重连后立即收到 snapshot

- GIVEN 一个进行中的 session 已积累若干 PTY 输出
- WHEN  新客户端通过 `/ws/sessions/:id` 连入
- THEN  客户端按顺序收到一个 `snapshot` 帧、一个 `status` 帧
- AND   `snapshot.data` 至少包含目前的 scrollback 内容

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

### Requirement: 输出微聚合（leading-edge debounce）

服务端 MUST 用 **leading-edge** debounce 模式处理 PTY 输出：

- 当 buffer 内**没有**定时器在跑时（即"刚从空闲恢复"），收到第一个 PTY
  data 事件 MUST **立即** 把 buffer flush 成一帧 `output`。这样用户键盘
  echo / 单字符回显**不会被微聚合的窗口期延迟**。
- 立即 flush 之后 MUST 同时启动一个 100 ms 的 trailing 窗口，期间所有 PTY
  data 累积到 buffer；窗口到期时把累积内容统一 flush 成一帧 `output`。
  trailing 窗口处理高频重绘（Ink TUI repaint storm），让 frame 速率有上界。

session 状态变化（status 事件）或 exit 时 MUST 立即触发 flush，不留尾巴。

#### Scenario: 单字节立即可见（不被聚合窗口延迟）

- GIVEN 服务端 buffer 已为空、无定时器在跑
- WHEN  PTY 写入一个字符（例如键盘 echo）
- THEN  客户端在该字符到达后的极短时间内（远小于 100 ms）收到一帧 `output` 含该字符

#### Scenario: 高频重绘期间帧速率被聚合限制

- GIVEN PTY 在 100 ms 内连续写入多次（Ink TUI 重绘）
- WHEN  服务端处理这些数据
- THEN  客户端最多收到 2 帧 `output`：一帧是首字节立即 leading flush，
        一帧是 trailing 窗口结束时把后续累积内容一次发出

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

session 触发 exit 事件时，服务端 MUST 用 close code `1000` 关闭该 session
的所有 client，并清理订阅。

#### Scenario: PTY 死亡时所有 client 收到 1000

- GIVEN 一个客户端连到某 session
- WHEN  session 的 PTY 退出
- THEN  客户端 MUST 在合理延迟内收到 close 帧，code = `1000`

### Requirement: 重连语义

客户端可以多次连接同一 `:id`。每次连接都 MUST 收到完整的 `snapshot` + `status`
初始化序列；服务端不做"已连接过此 client"之类的去重，因为没有稳定的客户端身份。

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
