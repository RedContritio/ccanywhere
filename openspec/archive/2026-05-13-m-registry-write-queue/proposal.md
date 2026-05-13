---
status: planned
---

# Proposal: m-registry-write-queue — SessionRegistry 同 id writes 串行

## Intent

m-session-persistence P11 commit 时观察：`manager.persistence.test.ts >
markDeleted persists deletedAt eagerly` 在 full test suite 并发跑时偶尔
fail，JSON parse 报错（content corrupt）。Isolated 跑稳定 pass。

Root cause: `manager.markDeleted` 触发两条并发 `registry.save(info, ...)`
writes 到同一 `<id>.json`：
1. markDeleted 内立即 save（eager crash safety per D2）
2. PTY SIGINT 退出后 `handleSessionExit` 又 save（with final deletedAt）

两个 writeFile 并发对同一 path，OS 层 truncate + write 非原子，繁忙时
交错损坏文件。

修复：给 SessionRegistry 加 per-id chain，同一 id 的 save / saveScreen /
delete / deleteScreen 串行。不同 id 仍并行（性能不退化）。

## 决策

D1. **chain 形态**：内嵌 `private writeChains: Map<id, Promise>` + 私有
    `serialize(id, op)` helper。不抽 util 类——本次只此一处使用，过度
    设计；类内 ~10 LOC 实现即可。

D2. **chain 不因 prev rejection 中断**：`prev.then(op, op)` —— 一条
    write 失败不阻断同 id 后续 writes（registry 内部 catch 已 log，
    无 propagate）。

D3. **chain auto-GC**：每条 chain settled 后 finally hook 检查 map 中
    最新值是否仍是自己，是则 drop。避免无限增长。

D4. **不串行不同 id**：跨 id 并发不动，保持 N-session 写盘 throughput。

D5. **regression test**：100 次同 id 并发 save（每次 deletedAt 不同），
    最终 file = 最后一次内容 + JSON valid。fix 前可能 flaky，fix 后 100%
    deterministic pass。

## 落地点

**改写**：
- `src/session/registry.ts`：加 `writeChains` field + `serialize(id, op)`
  helper + `save` / `saveScreen` / `delete` / `deleteScreen` wrap

**改 test**：
- `src/session/registry.test.ts`：加 "serializes writes to the same id
  (regression: B10)" case

## 形式化保证

F1. 同一 `<id>` 的所有 mutating writes（save / saveScreen / delete /
    deleteScreen）MUST 串行执行。
F2. 不同 id 的 writes MUST 仍可并发，throughput 不降。
F3. 一条 chain 中某 op 抛异常 MUST NOT 阻塞同 id 后续 ops（chain 仍
    forward 进 next）。

## 不做

- 不抽 util 类 / function（只此一处使用）
- 不改 loadAllSync（read 路径无 race）
- 不引 mutex / semaphore lib

## 范围估算

| 模块 | LOC |
|---|---|
| registry.ts (chain helper + wrap) | ~22 |
| registry.test.ts (race regression) | ~15 |
| **总** | **~37 LOC** |

## Commit 边界

单笔 commit `fix(server): m-registry-write-queue — SessionRegistry 同 id
writes 串行 (B10)`。

## 关联

- 出处：BACKLOG B10（m-session-persistence P11 观察）
- 不影响其它 in-flight change
