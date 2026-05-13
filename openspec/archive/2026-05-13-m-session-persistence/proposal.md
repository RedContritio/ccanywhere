---
status: planned
---

# Proposal: m-session-persistence — session metadata + 最后一屏 跨重启持久化

## Intent

ccanywhere 重启后 session list 全空，user 必须重新创建并丢失所有 cc
对话连续性。本方案：持久化 SessionInfo metadata + ScreenState 最后
一屏到磁盘；重启后 session 全部以 **dead** 状态加载进 list；user 点
进 dead session 看最后一屏 → 显式按 Resume → 这时才 spawn cc with
`--resume <id>` 接续 conversation。

**不**做 boot-time auto-spawn（避免 N×cc 启动开销 + 失败 blast
radius）。死了就是死了，恢复是 user-driven。

## 现状审计

- `SessionManager` (`src/session/manager.ts:69`) 内存 Map，无持久化
- shutdown (`src/cli/serve.ts:132`) `manager.killAll()` 杀所有 PTY
- **关键**：ccanywhere session id = cc jsonl 文件名（`manager.ts:111`
  `forcedSessionId` 通过 `--session-id <uuid>` 传给 cc）→ cc jsonl 是
  conversation state 的 source of truth，ccanywhere 只需要持久化 list
- PTY exit 的所有路径（A 类 cc 退出 / B 类 user DELETE / C 类 shutdown
  / D 类外部 kill / crash）都汇聚到 `SessionImpl.pty.onExit`（`session-
  impl.ts:67`）让 state='dead'。本方案视所有非 B 类 dead 一律：保留
  metadata + 最后一屏

## 决策（已与 user 拍板）

D1. **resume spawn args = 当前 config args + `--resume <id>` +
    `--session-id <id>`**。args 不持久化，跟 config 走。

D2. **metadata 写盘 = 异步 fire-and-forget**（`void registry.save(...)`），
    libuv pool 跑，main 不阻塞。失败 log + 内部错误上报（不影响 user
    response）。

D3. **dead 分类处理**：
    - A / C / D 类（cc 退出 / shutdown / 外部 kill / crash）：metadata
      保留 + 最后一屏 snapshot 落盘；user 点 Resume 才 spawn 新 PTY
    - B 类（user DELETE）：deletedAt 持久化 + GC ttl 后 hard delete
      metadata + screen file

D4. **user 点 Resume 时 spawn 失败**：返回 5xx + error 给 frontend；
    session 保持 dead，可看最后一屏 + 重试 / 删除。

D5. **boot 时 load metadata 是 sync** 阻塞 listen 几十 ms（N < 100 个
    小 json 文件 readdir + readFile）。换 listen 后 list 完整可见。

D6. **一文件一 session metadata** `<configDir>/sessions/<id>.json`；
    最后一屏 separate file `<configDir>/sessions/<id>.screen.txt`
    （metadata 小，list 热路径；screen KB 级独立 IO）。

D7. **resume lock `_activeResumeTargets`** 由 `manager.spawn` 已有逻辑
    自动重建（`manager.ts:156-166`）—— Resume endpoint 调 spawn
    时自然 set lock。无额外代码。

D8. **Level 2 不做**（scrollback 持久化）。最后一屏够 user 看上下文。

D9. **路径 hardcode** `<configDir>/sessions/`，不进 config schema
    （避免 schema bump + prod config 同步成本）。

D10. **SessionManager 数据结构 = 双 Map**：`sessions: Map<id,
     SessionImpl>` (active) + `deadStubs: Map<id, DeadStub>`。
     `DeadStub` 是 SessionInfo + deletedAt + last screen text 的纯
     数据，无 PTY 方法。`list()` merge 两个 map。

D11. **dead session 无 retention policy**（无自动 GC）；user 主动删
     才走 B 类路径。BACKLOG follow-up：可选 retention 配置。

## 落地点

**新**：
- `src/session/registry.ts` — `SessionRegistry` 类：`save(info,
  deletedAt) / saveScreen(id, text) / delete(id) / load(): Persisted[]
  + screen`
- `src/session/registry.test.ts` — CRUD / corrupt json / missing dir
  / 并发 save / screen 文件分离 各 case
- `src/session/dead-stub.ts` — `DeadStub` 类型 + factory
- `src/server/routes/sessions-resume.ts` — POST /api/sessions/:id/
  resume + GET /api/sessions/:id/screen 两个 endpoint
- `src/server/routes/sessions-resume.test.ts` — 各 case
- `web/src/pages/workspace.tsx` 中的 dead state UI（pane 显示最后一屏 +
  Resume 按钮）

**改**：
- `src/session/manager.ts` —
  - 构造加 `registry`
  - 加 `deadStubs: Map<id, DeadStub>`
  - `spawn()` 成功后 `void registry.save(info, null)`
  - `markDeleted()` 后 `void registry.save(info, deletedAt)`
  - `gc()` hard delete 时 `void registry.delete(id)`
  - 加 `loadDeadStubs()`（boot 时调用，sync）
  - 加 `resumeDeadStub(id, spawnOpts)`（user 点 resume 时调用，把 dead
    stub 转 active spawn）
  - 加 `getScreenSnapshot(id)`（返回 dead stub 的 last screen text）
  - `list()` merge sessions + deadStubs
- `src/session/session-impl.ts` — `onExit` 内 `screenState.dispose()`
  之前先 snapshot text，传给 manager 写盘
- `src/session/types.ts` — `SessionInfo.deletedAt?` 字段进类型
- `src/cli/serve.ts` —
  - 构造 `new SessionRegistry(<configDir>/sessions)`
  - 传给 SessionManager
  - listen 前 `manager.loadDeadStubs()` (sync)
  - shutdown 不再 `killAll()`（保留 metadata），改 `manager.detach()`
    让 listeners 解绑（PTY 会因 OS SIGHUP 死，但 onExit 写 snapshot
    fire-and-forget 走完）
- `src/server/server.ts` — wire 新 routes
- `web/src/pages/workspace.tsx` — terminal pane state='dead' 时显示
  Resume + snapshot
- `web/src/state/sessions.ts` — 加 `resumeSession(id)` action

## 形式化保证

F1. **每个 active session 在 metadata 目录有且仅有一个 json file**
    （spawn 写 / hard delete 删）。
F2. **每个 dead session 有 metadata + screen.txt 两个 file**（dead
    时 onExit 写 screen，spawn → dead 是单向）。
F3. **重启前后 sessions list 内容相同**：active 变 dead（state 改
    变），dead 保留，deletedAt 超 ttl 的 B 类被 hard delete。
F4. **GC ttl 跨重启延续**：deletedAt 持久化在 metadata，loadDeadStubs
    时如已超 ttl 直接 unlink metadata + screen file（不入 deadStubs
    map）。
F5. **resume 后 dead stub 转 active**：原 ccanywhere id 不变（cc
    jsonl 文件名不变），lock 自动重建（`_activeResumeTargets` set），
    旧 screen.txt 删除（snapshot 失效）。

## 验证（test 必须）

- registry CRUD + 并发 save + corrupt json fail-soft
- manager spawn → exit → write snapshot → load → list 含 dead stub
- resume endpoint：dead → active 转换 + lock 正确 set
- screen endpoint：返回 last snapshot text
- e2e：本机服务 spawn 2 session → kickstart → list 全 dead 含 snapshot
  → resume 一个 → spawn 新 PTY 接续 cc history

## 范围估算

| 模块 | LOC |
|---|---|
| registry.ts | ~120 |
| registry.test.ts | ~130 |
| dead-stub.ts | ~20 |
| manager.ts 改 | ~80 |
| manager.test.ts 增 | ~60 |
| session-impl.ts 改（snapshot on exit） | ~30 |
| types.ts | ~15 |
| serve.ts | ~20 |
| routes/sessions-resume.ts | ~80 |
| routes/sessions-resume.test.ts | ~120 |
| server.ts wire | ~10 |
| web workspace.tsx (dead state UI) | ~100 |
| web state/sessions.ts (resumeSession action) | ~30 |
| web/e2e visual (dead state 截图) | ~40 |
| **总** | **~855 LOC** |

## Commit 边界

- C1: registry.ts + dead-stub.ts + tests
- C2: session-impl.ts onExit snapshot + manager.ts 集成（spawn/exit/
  delete 写 registry，loadDeadStubs，resumeDeadStub，list merge）+
  manager.test 增
- C3: serve.ts boot 接线 (loadDeadStubs, detach 改 shutdown)
- C4: POST /resume + GET /screen routes + tests + server.ts wire
- C5: web frontend dead state UI + resumeSession action + e2e
- C6: 集成 e2e 跨重启测试（spawn → kickstart → list dead → resume →
  alive）

## 不做

- Level 2 scrollback 持久化（最后一屏够；BACKLOG follow-up）
- PTY 进程跨重启存活（Level 3/4，复杂度爆炸）
- dead session 自动 retention（user-driven 删；BACKLOG follow-up）
- 持久化 live state (busy/idle)
- WS 在 dead session 上行为：frontend 不连，REST 拿 snapshot

## 关联

- 出处：用户 ad-hoc 提出 + 多轮 review 收敛
- 后续 BACKLOG：
  - Level 2 scrollback 持久化
  - dead session retention policy（auto delete over N 天 / total
    size）
