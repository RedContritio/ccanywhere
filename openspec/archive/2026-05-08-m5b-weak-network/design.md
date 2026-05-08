# Design

## Idempotency-Key

### 数据结构

```
type CacheEntry = {
  bodyHash: string;        // sha256(body) hex
  status: number;          // 缓存的响应状态码（仅 2xx 或 4xx 入缓存）
  body: unknown;           // 缓存的 JSON body
  expiresAt: number;       // epoch-ms
};

class IdempotencyStore {
  private map: Map<string, CacheEntry>;  // key = `${authTokenLabel}:${idempotencyKey}`
  private ttlMs: number;
}
```

### 处理流程（应用于 `POST /api/sessions`）

1. 读 `Idempotency-Key` header。**不存在则跳过整个机制，按原逻辑走**。
2. 校验 key：`/^[A-Za-z0-9_-]{1,255}$/`，不合法 → `400 invalid_idempotency_key`。
3. 计算 `bodyHash = sha256(canonical(req.body))`，canonical 用 `JSON.stringify`
   的稳定序列化（key 排序）。
4. 查 store：
   - 命中且 `bodyHash` 一致：返回缓存的 `(status, body)`，附 `Idempotency-Replayed: true` 头。
   - 命中且 `bodyHash` 不一致：返回 `409 idempotency_conflict`。
   - 未命中：处理请求，**仅当响应状态码在 [200,500) 时**入缓存，附
     `Idempotency-Stored: true` 头；5xx 不入缓存（让客户端重试有机会触达不同后端实例）。
5. TTL 默认 3600 秒。entry 通过惰性过期（每次查询时检查 `expiresAt`）+
   定时 sweep（每 5 分钟 unref 的 timer）。

### Per-token 命名空间

key 以 `authTokenLabel` 为前缀，避免不同设备复用同一 `Idempotency-Key`
字面值时互相误命中。`authTokenLabel` 已在 onRequest hook 中决定。

### 存储边界

存储在内存，进程重启后丢失。这是预期：弱网络重试通常发生在分钟级，而非
跨进程重启级。如果未来需要跨重启，再用 sqlite 文件持久化（不在本提案范围）。

### 不缓存的情形

- 5xx 响应：客户端重试可能到不同进程或修复后的进程。
- 没带 `Idempotency-Key` 的请求：不缓存、不查询。

## WebSocket 心跳

### 协议层 vs 应用层

ccanywhere 的 WS 协议已有应用层 `ping`/`pong` 帧（见
`ws-protocol/spec.md`），那是**客户端发起**的探活，本提案**不动**它。

本提案新增的是**服务端发起**的帧级 ping（RFC 6455 Section 5.5.2），
利用 `ws` 库的 `socket.ping()`。客户端（浏览器 / `ws` Node）会自动回
帧级 pong，无需任何业务代码。

### 配置

```
config.wsHeartbeat = {
  intervalMs: 30_000,   // 默认 30 秒
  timeoutMs: 60_000,    // 默认 60 秒；> intervalMs 必要
}
```

### 实现要点

每个 client 连接时：

```
const state = { lastPongAt: Date.now() };
sock.on('pong', () => { state.lastPongAt = Date.now(); });
const timer = setInterval(() => {
  if (Date.now() - state.lastPongAt > timeoutMs) {
    sock.terminate();          // 强制立即关 TCP，不发 close 帧
    clearInterval(timer);
    return;
  }
  sock.ping();
}, intervalMs);
sock.on('close', () => clearInterval(timer));
```

`terminate()` 和 `close()` 区别：close 走握手且会把待发数据发完，
terminate 直接关 TCP——死链场景下握手不会成功，必须 terminate。

### 不做的事

- 不广播心跳事件给应用层。心跳只关心 socket 活性，不暴露给前端。
- 不调整应用层 `pong` 帧的语义。两条心跳通道独立。

## Deleted session GC

### TTL

`config.deletedSessionTtlMs`，默认 10 分钟（`600_000` ms），最小 `60_000` ms（1 分钟）。

10 分钟来自单用户单服务的真实场景：移动端切 4G/Wi-Fi 通常秒级到分钟级，
frp 链路重连秒级；超过 10 分钟用户基本已回到正常状态，重试 DELETE 不再有
意义。再长（比如 24h）只是让 manager map 多堆 entry，没有可观察价值。

### 触发时机

GC 不开独立后台 timer，而是在以下"活动入口"机会性触发：

- `manager.spawn()` 进入时。
- `manager.list()` 与 `manager.listActive()` 进入时。

理由：服务端 idle 时（无人创建/列举 session）GC 即使不跑也没人观察到副作用；
有访问就清理，无访问就不清理。这避免了 timer drift 与 `setInterval` 在
process suspend 时的累积问题。

### 算法

```
function gc(now: number) {
  for (const [id, s] of sessions) {
    if (s.deletedAt !== null && s.deletedAt + ttlMs < now) {
      // PTY 应该已经死透（markDeleted 触发了 kill），保险起见再 cleanup hook dir
      sessions.delete(id);
    }
  }
}
```

### 客户端可见性

GC 之前：DELETE 后 GET /api/sessions 仍能看到该 session（带 deletedAt）。
GC 之后：DELETE 过的 session 从 list 中消失，再次 DELETE 同 id 返回 404。

`rest-api/spec.md` 中 DELETE 表的"never existed"分支因此扩展含义为
"never existed **or expired from GC**"。客户端在弱网络下重试 DELETE 的
窗口与 TTL 一致——10 分钟足够覆盖单设备移动场景的合理重试。

### 不用 `lru-cache` 等现成工具的理由

`lru-cache` v10+ 支持 `set(k, v, { ttl })` 的 per-entry TTL，技术上能表达
"活 session 传 `Infinity`、死 session 传 `ttlMs`"。本提案不采用，理由：

- `lru-cache` 的 iteration 顺序是 LRU（访问顺序），不是 insert 顺序；
  `manager.list()` 当前依赖稳定 insert 序，换库会让响应顺序漂移。
- 活/死 session 是同一对象的不同 lifecycle，分两套缓存反而割裂。
- 惰性扫描的实现是 10 行代码，在 spawn/list 入口顺手扫，没有 timer 也没有
  额外内存开销，回报不值得依赖。

idempotency store 是同质 TTL 缓存，更适合 `lru-cache`；本提案在 design 阶段
未决定是否采用，留给实现时按代码量决定（若手写超过 30 行则改用 lru-cache）。

## 与现有契约的接口

修订点：

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `config/spec.md` | MODIFIED Requirement: 配置 schema | 新增 `deletedSessionTtlMs`、`wsHeartbeat` 字段 |
| `rest-api/spec.md` | ADDED Requirement: Idempotency-Key | POST /api/sessions 的幂等键处理 |
| `rest-api/spec.md` | MODIFIED Requirement: DELETE | 404 分支增加"或被 GC 回收"语义 |
| `ws-protocol/spec.md` | ADDED Requirement: 服务端心跳 | 帧级 ping/pong + terminate 阈值 |
| `sessions/spec.md` | ADDED Requirement: deleted GC | TTL 与触发入口 |

## 拒绝的备选方案

- **持久化 idempotency store**（sqlite/redis）——超出弱网络硬化范畴，
  增加部署复杂度。需要时单独提案。
- **强制 `Idempotency-Key`**——破坏现有客户端兼容性，且单用户单设备场景下没必要。
- **应用层心跳替代帧级**——浏览器对应用层定时器在 background tab 节流严重
  （>1 分钟），帧级 ping 走 OS 网络栈不受影响。
- **WS 死链由超时 backpressure 顺带处理**——理论上行，但要等积累 1MB
  buffered 才触发，期间 PTY 数据被白送给 dead socket，浪费 CPU 与带宽。
- **deleted session 用独立 timer GC**——增加 idle 状态下的后台开销，
  且 timer 行为在 fork worker / suspended process 下不可靠。
