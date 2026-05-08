## ADDED Requirements

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
