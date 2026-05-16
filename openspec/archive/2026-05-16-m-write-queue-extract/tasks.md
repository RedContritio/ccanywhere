# Tasks: m-write-queue-extract

## 决策对齐

- [ ] WriteQueue 自建（不注入）
- [ ] 不暴露 drain（暂不动 shutdown 语义）

## 实现

- [ ] `src/lib/write-queue.ts`：`class WriteQueue<K extends string>` —
      `enqueue(key, op: () => Promise<T>): Promise<T>`，内部
      `Map<K, Promise<unknown>>`，self-cleanup
- [ ] `src/share/store.ts`：删 `private serialize` + `writeChains`；
      构造器自建 `new WriteQueue<string>()`；save / delete 走 enqueue
- [ ] `src/session/registry.ts`：同上替换

## 测试

- [ ] `src/lib/write-queue.test.ts`：
  - 同 key 串行（op1 resolve 顺序在 op2 之前）
  - 跨 key 并行（两 key 同时 enqueue，两 promise 同时执行）
  - rejection 不阻塞后续 enqueue
  - self-cleanup（settle 后 Map 不残留 key）
- [ ] 跑 `pnpm test` 确认 share/store + session/registry 现有测试全过

## Spec delta

- [ ] 无 — 纯 internal refactor，外部 store 契约不变

## Ship

- [ ] typecheck:all + lint + lint:md + test pass
- [ ] build:all + launchctl kickstart + healthz 200
- [ ] commit hash:
