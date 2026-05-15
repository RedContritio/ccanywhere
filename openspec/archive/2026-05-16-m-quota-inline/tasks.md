# Tasks

## 段 1：QuotaWatcher 模块

- [ ] T1.1 `src/quota/watcher.ts` 新建：`class QuotaWatcher` 接 `userStore` + `now`；`start(session, user)` 启 fs.watch + debounce schedule、`stop(sessionId)` close watcher、`closeAll()`
- [ ] T1.2 watcher 内部 `await ccusageCalc(jsonlPath, user.createdAt)` → `userStore.setQuotaUsage(user.id, costUsd, totalTokens)`
- [ ] T1.3 owner kind 在 `start` 内部 early-return（不 watch、零 fs 开销）
- [ ] T1.4 `src/quota/watcher.test.ts`：fs append 触发 → setQuotaUsage 被调；debounce window 内多次 append 只触发一次；stop 后 close watcher 不再触发；owner kind 不 watch

## 段 2：SessionManager 集成 watcher

- [ ] T2.1 `src/session/manager.ts` SpawnOptions / SessionManagerOptions 加可选 `quotaWatcher: QuotaWatcher`；`spawn` / `resumeDeadStub` 末尾调 `watcher?.start(session, user)`（user 通过 options 注入或 sessionInfo.userId 反查 userStore）
- [ ] T2.2 session dispose / killAll 调 `watcher?.stop(session.info.id)`
- [ ] T2.3 `src/session/manager.test.ts` 加测试：spawn 后 watcher.start 被调；killAll 后 stop 被调

## 段 3：WS input gate

- [ ] T3.1 `src/ws/protocol.ts` ServerFrameSchema 加 `{ type: 'quota_exhausted', reason: string }`
- [ ] T3.2 `src/ws/server.ts` `case 'input'` 写 PTY 前查 `userStore.findById(session.info.userId).quota` → 超额发 `quota_exhausted` frame、不写 PTY
- [ ] T3.3 owner kind / `req.user === undefined`（legacy fixture）pass
- [ ] T3.4 `registerWebSocketRoutes` 签名加可选 `userStore`；buildServer 注入
- [ ] T3.5 `src/ws/server.test.ts` 加测试：user 超额 → input 不到 PTY + frame 'quota_exhausted'；owner 不被 block；缺 userStore 时不 block（向后兼容）

## 段 4：删 hook.ts quota check

- [ ] T4.1 `src/server/routes/hook.ts` 删 UserPromptSubmit 分支里的 `checkQuota` 调用 + block JSON 返回路径
- [ ] T4.2 删 `checkQuota` / `decide` / `QuotaBlockDecision` / `QuotaCheckOutcome` helper / interface
- [ ] T4.3 `HookRoutesOptions.userStore` 字段拆解：state machine 不依赖即删该字段
- [ ] T4.4 `src/server/server.quota-hook.test.ts` 现有"hook 触发 quota block"测试改成测 inline gate；命名调整或拆文件

## 段 5：buildServer wire

- [ ] T5.1 `src/server/server.ts` 构造 QuotaWatcher（仅当 userStore 注入时）
- [ ] T5.2 把 watcher 传给 SessionManager + WS handler
- [ ] T5.3 onClose hook 内 watcher.closeAll()

## 段 6：web 端处理 `quota_exhausted` frame

- [ ] T6.1 `web/src/state/session-frames` 或类似处理 frame：触发 toast（复用现有 toast）+ 立即 refetch `/api/me/quota`
- [ ] T6.2 web 测试覆盖（如有 ws frame 路由测试）

## 段 7：Spec delta

- [ ] T7.1 `openspec/specs/hooks/spec.md` "quota 单一 enforcement 点 = UserPromptSubmit hook" 改为 "quota enforcement 已搬到 ws input gate（m-quota-inline）；hook 仅做 state transition"
- [ ] T7.2 `openspec/specs/ws-protocol/spec.md` 加 `quota_exhausted` server frame
- [ ] T7.3 `docs/hooks.md` 加 note：UserPromptSubmit hook 不再是 quota 必需配置（state machine 仍依赖）

## 段 8：Build & Deploy

- [ ] T8.1 typecheck:all + lint + lint:md + test 全绿
- [ ] T8.2 build:all
- [ ] T8.3 launchctl kickstart -k；healthz 200 验
- [ ] T8.4 server.log 检查：watcher 启动 log

## 段 9：Dogfood 复验 quota（接续 m-user-symmetric §10.3 的 B 视角）

- [ ] T9.1 e2e 浏览器仍持原 token cookie；进 `dogfood-quota` 项目；起 cc session
- [ ] T9.2 第一轮 prompt 后约 500ms~1s 内观察：web quota panel `tokens.used` 应自动上涨（watcher fs.watch 触发）
- [ ] T9.3 继续 prompt 直到 used >= 1000；下一次 input 应被 web UI block（`quota_exhausted` frame → toast）；cc 收不到 input
- [ ] T9.4 owner 视角验：所有 input 通过；watcher 不启动；hook 行为不变

## 段 10：Commit + Archive

- [ ] T10.1 commit（含 archive 路径 + spec delta 摘要）
- [ ] T10.2 mv openspec/changes/m-quota-inline → openspec/archive/<date>-m-quota-inline
