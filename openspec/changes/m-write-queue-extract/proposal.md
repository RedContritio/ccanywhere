---
status: planned
---

# Proposal: m-write-queue-extract — 抽公共 WriteQueue helper

## 状态

planned。`src/share/store.ts:42-66` 与 `src/session/registry.ts:42-63`
各自实现的 per-key 写链几乎逐字相同：

- 同样 `Map<string, Promise<unknown>>` 字段
- 同样 `prev.then(op, op)` chain (异常不阻塞后续 op)
- 同样 `void next.finally` self-cleanup

两段都引用 archive `m-registry-write-queue` (B10)。重复约 25 LOC × 2 =
50 LOC，缺共同抽象。下一处需要 per-key 写串行化的 store (假如未来
feedback-seen-store 或 IdempotencyStore 持久化扩展) 必然再抄一遍。

## Intent

抽 `src/lib/write-queue.ts` 一个 ~30 LOC 的 `class WriteQueue<K>`，两个
store import 后删 `private serialize` + `private writeChains`。

## 形式化保证

`WriteQueue<K extends string>` MUST：

- **同 key 串行**：`enqueue(k, op1); enqueue(k, op2)` 必保 op1 settle 后
  才开始 op2
- **跨 key 并行**：`enqueue('a', opA); enqueue('b', opB)` 可同时执行
- **异常不阻塞**：op rejection 不影响后续相同 key 的入队 op
- **self-cleanup**：链 settle 后从内部 Map 删 key，避免无限增长

## 落地点

- 新建 `src/lib/write-queue.ts` (~30 LOC)
- 改 `src/share/store.ts` — 删 `:42-66` serialize；构造器自建 WriteQueue；
  save / delete 走 `queue.enqueue(code, op)`
- 改 `src/session/registry.ts` — 同上替换
- 新建 `src/lib/write-queue.test.ts` (~50 LOC)

## 范围

~80 LOC：+80 新增 (queue + 测试) / -50 删两处重复 / +可读性

## 决策点（启动前定）

- WriteQueue 注入 vs store 自建：倾向 store 自建（更简单，测试已能从
  store 外部观察行为）
- 是否暴露 `drain()` 给 shutdown：现状 share/store 无 drain，session
  /registry 走 manager.detach 间接 drain。本 change 不动 drain 语义。

## 不做

- 不引入第三方（p-queue / async-mutex）：30 LOC 自写够 + 无外部 dep 风险
- 不改 store 公开 API 签名
- 不动测试中"假 fake fs" 这类细节

## 关联

- 出处：本评审 A1
- 依赖：可与 m-store-zod-load 并行做
