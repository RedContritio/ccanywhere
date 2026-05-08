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

### Requirement: 输出微聚合

服务端 MUST 把 PTY 数据缓存 100 ms 后再以一帧 `output` 发出（debounce flush）。
微聚合 buffer 跨多个 PTY 数据事件累积，第一次写入触发定时器，定时器到期时统一
flush。session 状态变化（status 事件）或 exit 时 MUST 立即触发 flush，
不留尾巴。

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
