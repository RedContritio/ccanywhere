# Tasks: m-registry-write-queue (planned)

## Phase 1 — 实现 + test

- [x] T1.1. `src/session/registry.ts` 加 `writeChains` field +
  `serialize(id, op)` 私有 helper
- [x] T1.2. wrap `save` / `saveScreen` / `delete` / `deleteScreen` 4
  method 走 serialize
- [x] T1.3. `src/session/registry.test.ts` 加 race regression case
  (100 次同 id 并发 save，最终 file valid + deletedAt = 99)
- [x] T1.4. typecheck:all / lint / lint:md / test 全过

## Phase 2 — Ship

- [x] T2.1. build:all + kickstart + healthz 200
- [x] T2.2. commit `fix(server): m-registry-write-queue — SessionRegistry
  同 id writes 串行 (B10)`
- [x] T2.3. archive `mv changes/m-registry-write-queue
  archive/<date>-m-registry-write-queue` + 回填 hash
- [x] T2.4. spec delta：`openspec/specs/sessions/persistence.spec.md`
  "持久化存储" 段加同 id 写入串行约束 + F1-F3 Scenario
- [x] T2.5. BACKLOG.md 删 B10

## Commits

- (no matching commits found in git log)
