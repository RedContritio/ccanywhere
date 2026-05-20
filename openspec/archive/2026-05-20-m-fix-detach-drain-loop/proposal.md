# Proposal: m-fix-detach-drain-loop — detach() snapshot-once 漏掉 await 期间新入队 write

## Intent

`src/session/manager.persistence.test.ts:67 "markDeleted persists deletedAt eagerly (crash safety)"` 整套 `pnpm test` 跑时间歇 fail (~17% rate)。

误读:表象上看是 line 78 `expect(parsed.deletedAt).not.toBeNull()` fail。实际是 line 77 `JSON.parse(text)` 抛 `SyntaxError: Unexpected end of JSON input` — `text` 是空字符串。

Root cause(来自并行 agent 调研 + web 来源验证):

时序(`manager.persistence.test.ts:67-79`):

1. `mgr.spawn(...)` → `trackWrite(save_null)` + `trackWrite(delScreen)` 入 `pendingWrites`(`manager.ts:113-114`)
2. `mgr.markDeleted(id)`:
   - `session.markDeleted()` 设 `deletedAt`
   - **fire-and-forget `kill()`** (sends SIGINT to PTY)(`session-impl.ts:137-143`)
   - `trackWrite(save_nonNull)` 入 `pendingWrites`(`manager.ts:198-201`)
3. `await mgr.detach()`:`[...pendingWrites]` snapshot + `Promise.allSettled`(`manager.ts:271-273`)
4. **await 期间**:SIGINT 杀 sh → `pty.onExit` 触发 → SessionImpl onExit 调 `handleSessionExit`
5. `handleSessionExit`(`manager.ts:279-291`)调:
   - `trackWrite(registry.save(info, deletedAt))`
   - `trackWrite(registry.saveScreen(...))`
   两个 write **加入 pendingWrites 在 detach 已经 snapshot 之后** → 不在 detach await 范围
6. `detach()` 返回 → 测试 `await readFile(...)`
7. post-exit `save(info, deletedAt)` 并发跑:`fs/promises.writeFile = open(O_TRUNC) → write → close`
8. **Race window**:`open(O_TRUNC)` 把文件 truncate 到 0 字节,在 `write` syscall 完成前,readFile libuv worker 可能 open + read → 拿到 `''` → `JSON.parse('')` 抛 SyntaxError

是 source bug,不是 test bug。`detach()` 契约文档化为 "shutdown flush" — 应该 drain 所有 pending writes。snapshot-once 漏掉 await 期间新入的 promise。

**生产影响**:`cli/serve.ts:235` graceful shutdown 也调 `manager.detach()`。如果 PTY 在 shutdown flush 窗内 die,handleSessionExit 触发的 save 可能没被 await,server 进程退出时 fs write 半完成 → 下次 boot 读到 truncated JSON → loadAllSync 会 skip(`loadJsonRecord` catch SyntaxError),但 session 元数据丢失。

## 落地点

- `src/session/manager.ts:271-273` — `detach()` 改 loop drain (~5 LOC)
- `src/session/manager.detach-drain.test.ts` — 新 white-box regression test 直接验证 "detach 期间新入队的 write 也被 await"(~30 LOC,不依赖 PTY,纯 trackWrite + setTimeout 模拟)

## 决策

- **D1**: loop drain vs 改 `pendingWrites` 数据结构。loop drain 更小改动,~5 LOC。`pendingWrites` 是 Set 已经有 add/delete,加循环 await 直到 size === 0 就够。
- **D2**: white-box regression test vs 复现 PTY race test。**D2.A**: white-box — 直接调 `(mgr as any).trackWrite` 模拟 "await 期间新入队"。deterministic,不依赖 timing。**D2.B**: 复现 PTY race — race-prone,可能仍 flake。选 D2.A。

```diff
   async detach(): Promise<void> {
-    await Promise.allSettled([...this.pendingWrites]);
+    while (this.pendingWrites.size > 0) {
+      await Promise.allSettled([...this.pendingWrites]);
+    }
   }
```

终止性: 每个 settled promise 经 trackWrite 的 `.finally` 从 pendingWrites 移除(`manager.ts:293-296`),`handleSessionExit` per session 只 fire 一次,所以 chain 长度有限,loop 必然终止。

## 形式化保证

- 新 regression test 不依赖 timing,确定性 pass
- `for i in $(seq 30); do pnpm test 2>&1 | grep -c "manager.persistence.*FAIL"; done` 整套跑 30 次,manager.persistence 0 fail
- 现有 detach caller 不变(`cli/serve.ts:235` + 5 个 test 文件)

## Phases

- **C1**: manager.ts detach loop fix + regression test
- **C2**: 验证 30x + archive

## 不做

- 改 `pool: forks` → `threads` 或 `singleFork: true` — 掩盖问题,不修 root cause。生产 graceful shutdown 仍有同样 race
- 改 writeFile → write-and-rename atomic — scope 大,write-queue 已经 per-key 串行,不解决 detach 漏 promise 的根本问题

## Sources

- [nodejs/node#1058](https://github.com/nodejs/node/issues/1058) — `fs.writeFile` 是 `open(O_TRUNC) → write → close`,partial-write window 真实
- [nodejs/help#2346](https://github.com/nodejs/help/issues/2346) — 同文件 concurrent writeFile + reader race
- [vitest-dev/vitest#8861](https://github.com/vitest-dev/vitest/issues/8861) — fork pool 放大 libuv worker contention,IO race window 加宽
