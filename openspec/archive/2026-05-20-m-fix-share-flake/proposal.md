# Proposal: m-fix-share-flake — share/store fire-and-forget flake

## Intent

`src/share/store.test.ts:55 "load drops + unlinks expired record (lazy
GC per D6)"` 在 `pnpm test` 整套并发跑时间歇 fail(率 ~20%)。

Root cause: `share/store.ts:85` `load()` 检测过期记录后 `void this.delete(parsed.code).catch(...)` fire-and-forget;**store 自身不跟踪 pending deletes**。测试用两个 `setImmediate` await 试图等 IO 完成,但:

1. `delete()` 经 `WriteQueue.enqueue` 排队 — 至少一层 promise tick
2. 排队后的 op 调 `Promise.all([unlinkIgnoreMissing × 2])` — 真实 fs.unlink syscall(libuv worker pool)
3. fork pool 并发负载下 worker 排队,IO 完成 timing 不确定

`setImmediate × 2` 是"信仰"等待,不 deterministic。

## 落地点

- `src/lib/write-queue.ts` — 加 `idle(key)` 方法,返回 chain 当前 promise
  (= 该 key pending op 全完成的 promise)
- `src/lib/write-queue.test.ts` — 加 idle 单元测试
- `src/share/store.ts` — 加 public `idle(code)` 暴露 internal queue.idle
- `src/share/store.test.ts:53-54` — `setImmediate × 2` 改 `await store.idle(r.code)`

## 决策

- **D1**: idle API 在 WriteQueue 层,不是 store 层。原因:registry 也用 WriteQueue,可能后续也需要这个 seam。idle 是 queue 的固有概念。
- **D2**: `idle(key)` 单 key,不做 `idleAll()`。原因:测试通常知道具体 key;`idleAll()` 涉及 Map 迭代时机 trickier。需要时再加。
- **D3**: store `idle(code)` 是 public 方法,不是 `__testOnly` hack。原因:测试 seam 本身没有侵入性,生产代码不会调,但暴露 public 比 hack 干净。

## 形式化保证

- `pnpm test --run src/share/store.test.ts` 单跑 100/100 通过(原来也通过,这是 sanity)
- `for i in $(seq 30); do pnpm test 2>&1 | grep -c "share/store.test.ts.*FAIL\|store.test.ts.*fail"; done` 30 次整套跑,share/store 0 fail
- WriteQueue 现有契约不变(per-key 串行 / 跨 key 并行 / rejection 不污染后续)

## Phases

- **C1**: WriteQueue.idle + unit test
- **C2**: ShareStore.idle + 改测试
- **C3**: 跑 30 次整套验证 + archive

## 不做

- `src/session/manager.persistence.test.ts:67 "markDeleted persists deletedAt eagerly"` 的另一个 flake — 现象不同(`detach()` 已 track `pendingWrites`,但仍 fail),root cause 未定,在并行 agent 调研中。落另一个 change。
- `idleAll()` API(未来需要再加)
- `WriteQueue` 内部 chain 数据结构调整(idle 只读 chain map)
