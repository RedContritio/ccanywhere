# Proposal: 弱网络硬化 — Idempotency / WS heartbeat / GC TTL

## Intent

ccanywhere 通过 frp 暴露给公网，移动端切 4G/Wi-Fi、隧道抖动会让客户端
不可避免地遭遇丢包与超时。当前的契约对这类场景容忍度不足：

- `POST /api/sessions` 不幂等：客户端没收到 201 → 重试 → 创了两个 session。
- WS 死链不可见：客户端切网时不会发 close 帧，服务端持续把它当活，向 dead
  socket 广播 output，导致 `bufferedAmount` 累积、最终被 backpressure 关。
- session 软删除（M5 引入）让 manager 内存无界增长，`deletedAt !== null`
  的 session 永不释放。

本提案补齐这三处。

## Scope

包含：

- `POST /api/sessions` 支持 `Idempotency-Key` header（optional）。
- WebSocket 服务端心跳：`ping/pong` 间隔 + 超时 terminate。
- 软删除 session 的 GC：`deletedAt + ttl` 后从 manager 移除。
- 配置新增 `deletedSessionTtlMs`、`wsHeartbeat.{intervalMs, timeoutMs}`。

不包含（保持现状）：

- Hook 调用的重试/去重——cc 自身不重试 hook，状态机偏差由下次 user input
  自动重置（已在 `hooks/spec.md` 显式接受）。
- 客户端 REST 重试退避——前端责任，不在服务端契约。
- DELETE 的幂等性——M5 已通过软删除实现，本提案不再动。
- WS 应用层 input 去重——单连接内有序送达，跨重连由前端 echo 验证。

## Approach

**Idempotency-Key**：服务端维护 `Map<authToken+key, { bodyHash, status, body, expiresAt }>`，TTL 1 小时。命中且 body 一致返回缓存；命中 body 不一致返回 409；
不命中按正常流程处理，结果入缓存。Per-token 命名空间避免不同设备复用 key 互相影响。

**WS heartbeat**：利用 `ws` 库内置帧级 ping（非应用层 ping/pong 帧）。
每个连接 30 秒发一次 ping；若距上次 pong 超过 60 秒则 `socket.terminate()`。
客户端无需任何额外行为——`ws` 与浏览器 WebSocket 都自动应答帧级 ping。

**GC TTL**：manager 在 `spawn` 与 `list` 入口顺手扫一遍，移除
`deletedAt + ttl < now` 的 session。不开独立 timer，免得 idle 状态下还
跑后台任务；spawn 与 list 是天然的活动信号，可以承担清理职责。
