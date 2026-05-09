## ADDED Requirements

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
