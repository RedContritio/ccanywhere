# Tasks

## 1. 配置层

- [ ] 1.1 `src/config/schema.ts` 新增 `deletedSessionTtlMs`（默认 600_000 = 10 分钟，最小 60_000 = 1 分钟）
- [ ] 1.2 `src/config/schema.ts` 新增 `wsHeartbeat: { intervalMs, timeoutMs }`（默认 30000 / 60000，要求 timeoutMs > intervalMs）
- [ ] 1.3 `src/config/loader.test.ts` 增 4 个测试覆盖默认值、最小值、相对约束

## 2. Idempotency 中间件

- [ ] 2.1 新增 `src/server/idempotency.ts`：`IdempotencyStore` 类，含 `lookup(scope, key, bodyHash)`、`store(scope, key, bodyHash, status, body)`、`size()`，TTL 由构造参数注入
- [ ] 2.2 5 分钟 unref'd `setInterval` 做 sweep；store close 时 clearInterval
- [ ] 2.3 新增 `src/server/idempotency.test.ts`：lookup hit/miss、bodyHash 冲突、TTL 过期、scope 隔离、5xx 不入缓存
- [ ] 2.4 `src/server/routes/sessions.ts` 在 POST 入口接入：读 header → 校验 → 查/写 store；附 `Idempotency-Replayed` / `Idempotency-Stored` 响应头
- [ ] 2.5 `src/server/server.ts` 实例化 store 并注入 SessionRoutesOptions
- [ ] 2.6 `src/server/server.test.ts` 增 5 个测试：无 key 走原流程、同 key+body 命中、同 key 异 body 409、不同 token 隔离、TTL 过期后 key 复用

## 3. WS 心跳

- [ ] 3.1 `src/ws/server.ts` 接入心跳：每 client 一个 `lastPongAt` + interval；`pong` 事件刷新；超时 `terminate()`
- [ ] 3.2 心跳参数从 BuildServerOptions 透传（默认从 config 读）
- [ ] 3.3 `src/ws/server.test.ts` 增 2 个测试：正常 ping/pong 不踢；模拟 client 不回 pong 后被踢
- [ ] 3.4 测试用 `ws` 客户端注入 `pong` 静默：覆盖 `sock.pong = () => {}` 模拟死链

## 4. Deleted session GC

- [ ] 4.1 `src/session/manager.ts` 新增私有 `gc(now)` 方法
- [ ] 4.2 在 `spawn()`、`list()`、`listActive()` 入口调 `gc(Date.now())`
- [ ] 4.3 `SessionManager` 构造接受 `{ deletedSessionTtlMs }`，从 cli 注入
- [ ] 4.4 `src/session/manager.test.ts` 增 3 个测试：未到期不动、过期被回收、活的 session 不受影响

## 5. cli 集成

- [ ] 5.1 `src/cli.ts` 把 `config.deletedSessionTtlMs`、`config.wsHeartbeat` 透传给 manager 与 buildServer
- [ ] 5.2 `src/server/server.ts` `BuildServerOptions` 增 `idempotencyTtlMs` 与 `wsHeartbeat`，默认值在 buildServer 内部填

## 6. spec 归档

- [ ] 6.1 验证所有测试通过（pnpm typecheck && pnpm test）
- [ ] 6.2 把 `changes/m5b-weak-network/specs/` 下每个 delta 合并到 `openspec/specs/`
- [ ] 6.3 把 `changes/m5b-weak-network/` 移到 `archive/YYYY-MM-DD-m5b-weak-network/`
- [ ] 6.4 commit "M5b: idempotency keys, WS heartbeat, deleted session GC"
