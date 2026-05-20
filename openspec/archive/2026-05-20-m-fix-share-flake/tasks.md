# Tasks: m-fix-share-flake

## C1. WriteQueue.idle(key) + 单元测试

- [ ] T1.1 `src/lib/write-queue.ts` — 加 `idle(key): Promise<void>` 方法,
      返回 `this.chains.get(key) ?? Promise.resolve()`,但要 `.then(() => undefined)`
      包装避免泄漏 op 的 resolved value
- [ ] T1.2 `src/lib/write-queue.test.ts` — 加 unit test:
  - idle(unknown-key) resolves immediately
  - idle(key) waits for in-flight op to complete
  - idle(key) called multiple times resolves at same time
  - idle(key) after op completes resolves immediately(链条 self-cleanup 后)
- [ ] T1.3 `pnpm test --run src/lib/write-queue.test.ts` 全过
- [ ] T1.4 commit C1 — `<hash>`

## C2. ShareStore.idle(code) + 改测试

- [ ] T2.1 `src/share/store.ts` — 加 `idle(code: string): Promise<void>` public
      method 转发到 `this.queue.idle(code)`
- [ ] T2.2 `src/share/store.test.ts:53-54` — `await new Promise((r) => setImmediate(r));`
      × 2 改 `await store.idle(r.code);`
- [ ] T2.3 `pnpm test --run src/share/store.test.ts` 全过(原来也过,sanity)
- [ ] T2.4 commit C2 — `<hash>`

## C3. 验证 + archive

- [ ] T3.1 `for i in $(seq 30); do pnpm test 2>&1 | tail -2; done` 抓
      30 次整套跑结果,确认 share/store fail 0/30
- [ ] T3.2 `mv openspec/changes/m-fix-share-flake openspec/archive/2026-05-20-m-fix-share-flake`
- [ ] T3.3 commit C3 archive + hash 回填
