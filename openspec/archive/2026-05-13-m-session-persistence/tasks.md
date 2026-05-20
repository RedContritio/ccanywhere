# Tasks: m-session-persistence (planned)

## Phase 0 — 启动前对齐

- [x] T0.1. proposal D1-D11 + 不做项 + 范围 user 拍板
- [x] T0.2. metadata 路径 hardcode `<configDir>/sessions/`，不进
  config schema

## Phase 1 — C1 Registry + DeadStub

- [x] T1.1. `src/session/dead-stub.ts`：`DeadStub` 类型 + factory
- [x] T1.2. `src/session/registry.ts`：构造 mkdir + save/saveScreen/
  delete/deleteScreen (async fire-and-forget) + loadAllSync (boot
  用，含 corrupt-skip / missing-dir / hidden-file 过滤)
- [x] T1.3. `src/session/registry.test.ts`：14 case 含 roundtrip /
  delete / corrupt / malformed-shape / hidden+non-json skip / missing-
  dir auto-create / 并发 save / overwrite / missing-screen-file
- [x] T1.4. C1 commit + typecheck:all / lint / lint:md / test (329
  passed) ✓ (02f95c2)

## Phase 2 — C2 SessionImpl screen snapshot + Manager 集成

- [x] T2.1. `src/session/types.ts`：`SessionRow` interface 抽出（active
  Session + dead stub 共享 row shape，list 返 SessionRow[]）。
  SessionInfo.deletedAt 不进 interface（runtime SessionImpl 内 deletedAt
  仍是 mutable field；registry 单独 persist deletedAt 不进 SessionInfo）
- [x] T2.2. `src/session/dead-stub.ts`：DeadStub implements SessionRow
  + state='dead' 字段
- [x] T2.3. `src/session/session-impl.ts`：onExit 内在 dispose 前
  snapshot lastScreen → 通过新 `onSnapshotReady?` callback 给 manager
- [x] T2.4. `src/session/manager.ts`：构造接 registry；加 deadStubs
  Map；spawn / markDeleted / gc / handleSessionExit 路径都 trackWrite
  到 registry；新方法 loadDeadStubs / resumeDeadStub / findRow /
  getDeadStub / getScreenSnapshot / detach；行为变化：dead 后移到
  deadStubs Map，mgr.get(id) 返 undefined（用 findRow 访问）
- [x] T2.5. `src/session/manager-types.ts` 抽出：SpawnOptions /
  SpawnResult / SessionManagerOptions / buildEnv（300-line lint cap）
- [x] T2.6. `src/session/manager.persistence.test.ts`（新）：9 case 覆盖
  spawn-exit-写盘 / markDeleted 持久化 / loadDeadStubs GC + 健康加载 /
  resumeDeadStub / soft-deleted resume 抛 / list merge / gc 清 registry
- [x] T2.7. `src/session/manager.test.ts` 更新 dead state assertion：
  `mgr.get` 死后 undefined / 改用 `findRow` / `getDeadStub`
- [x] T2.8. C2 commit + 全测试通过 (338 passed) (ac062b1)

## Phase 3 — C3 serve.ts 接线

- [x] T3.1. `src/cli/serve.ts`：
  - 构造 `const sessionRegistry = new SessionRegistry(join(configDir,
    'sessions'))`
  - 传给 `new SessionManager({ deletedSessionTtlMs, registry })`
  - listen 之前 `manager.loadDeadStubs()` (sync)
  - shutdown 改 `await manager.detach()` 替代 `killAll()`：等 pending
    writes settle，不主动 kill PTY（OS SIGHUP 自然终止子进程触发
    onExit → snapshot 写盘）
- [x] T3.2. shutdown 时序：app.close → manager.detach (drains pending
  writes) → process.exit(0)
- [x] T3.3. C3 commit + build:all + kickstart + healthz 200 ✓ ；
  `~/.config/ccanywhere/sessions/` 自动创建 (f8f9afc)

## Phase 4 — C4 Resume + Screen API endpoints

- [x] T4.1. 不抽 `buildSpawnOpts` helper：resume endpoint 内 spawn opts
  比 POST /sessions 简单很多（cc args 固定 `--resume <id> --session-id
  <id>`，无 history validation、idempotency、forcedSessionId 等），
  inline 即可
- [x] T4.2. `src/server/routes/sessions-resume.ts`：
  - POST `/api/sessions/:id/resume`：404 unknown / 409 already_active /
    409 soft_deleted / 404 cross-user / 404 project_gone / 500
    resume_failed / 201 success
  - GET `/api/sessions/:id/screen`：404 / text/plain body
- [x] T4.3. `src/server/server.resume-dead-stub.test.ts`：9 case 覆盖
  所有 status code 路径
- [x] T4.4. `src/server/server.ts` 注册 registerSessionResumeRoutes
- [x] T4.5. `src/server/routes/sessions.ts` DELETE 改 manager.findRow +
  manager.markDeleted（支持 dead-stub deletion）
- [x] T4.6. C4 commit + 全测试通过 (347 passed) + healthz (62174e2)

## Phase 5 — C5 Frontend dead state UI

- [x] T5.1. `web/src/state/sessions.ts`：加 `resumeSession(id, req?):
  Promise<Session>` action — POST /api/sessions/:id/resume；成功后
  store 中替换该 session
- [x] T5.2. 复用 api() helper 处理 GET /api/sessions/:id/screen
  （api 内部对非 JSON content-type 自动 res.text() return as T，
  caller 用 `api<string>(path)` 拿 text）
- [x] T5.3. `web/src/pages/workspace.tsx` terminal pane：state='dead'
  && deletedAt===null 时渲染 `<DeadSessionPane>` 替代 TerminalView
  + header；不连 WS；Resume 成功后 navigate 让 TerminalView 重 mount
- [x] T5.4. `web/src/components/dead-session-pane.tsx`（新）：
  - mount fetch /screen → useState snapshot
  - 渲染 header (project name + 已结束 + Resume button + 删除 button +
    optional ☰ mobile)
  - 主体 `<pre className="font-mono whitespace-pre">` 渲染 snapshot
  - busy state / error toast 全覆盖
- [x] T5.5. `web/e2e/visual.spec.ts` 加 `dead session pane (Resume
  preview) dark mode` test：mock 3 endpoints（/sessions, /projects,
  /sessions/:id/screen）；assert "paused-proj"/已结束/Resume/last
  screen text 全 visible；clip 截 pane
- [x] T5.6. C5 commit + e2e visual 9 case 全过 + Read PNG 自检 (8fb1b30)

## Phase 5.5 — Dead pane 视觉统一（user review polish）

- [x] P1. user review C5 反馈"已结束页面变化太大，和原来完全不同"。
  原 DeadSessionPane 自带独立 header / 不同 chrome → 与 active pane
  视觉断裂
- [x] P2. 改为复用 active terminal pane 同一 layout：同一 `<header>`
  + `data-pane-content` + terminal-host 容器；仅 right-slot icons 换
  Resume/删除、ws-conn label 换"已结束"、terminal body 换 readonly
  snapshot `<pre>`、不渲染 MobileToolbar
- [x] P3. DeadSessionPane → DeadSessionSnapshot 重命名 + 只保留 inner
  snapshot 渲染（fetch + `<pre>`），无 header chrome
- [x] P4. 新增 `web/src/components/workspace-header-actions.tsx`：抽
  ActiveHeaderIcons / DeadHeaderActions 两 helper 让 workspace.tsx
  保 500-line lint cap 内
- [x] P5. shutdown 路径 bug 修复：原 `serve.ts` shutdown 只 `detach()`
  指望 OS SIGHUP 让 PTY 触发 onExit 写 snapshot——但 ccanywhere
  `process.exit(0)` 后 JS event loop 终止，onExit handler 永不
  执行 → snapshot 永不写。改回 `manager.killAll()` 主动 SIGINT
  PTY，await 每个 exit 触发 handleSessionExit 入 pendingWrites,
  再 `manager.detach()` drain 后退出。restart-recovery.test 早就
  显式 killAll 才没暴露这个 bug
- [x] P6. dead pane 渲染修复：`ScreenState.snapshot()` 通过
  `SerializeAddon` 输出含 alt-screen markers / cursor positioning /
  ANSI color attrs 的 ANSI control 文本，`<pre>` 直接渲染会显示
  raw escape codes。改用真 xterm.js Terminal（readonly,
  disableStdin, cursorBlink false, cols/rows = manager spawn
  default 100×30）feed snapshot text 让 xterm 解析 ANSI。视觉
  等同 active terminal 末帧
- [x] P7. resume 失败修复 #1：feedback `2026-05-12T10-19-51-527Z`。
  双 flag `--resume <id> --session-id <id>` cc 视为冲突 panic 退出。
  删 `--session-id`。— 不够
- [x] P11. /api/auth/me 改返 username 替代 device label。User flag
  "现在 schema 下 sidebar 应该换成 user name"。原 owner 返
  `label = device.label`（device 名）、limited 返 `label = user
  .username`（用户名）— 两者不一致。改 owner 路径 `label =
  userStore.getOwner().username`（固定 "owner"），与 limited 路径
  同语义（label = identity 而非物理设备名）。device label 概念在
  LegacyDevice store 保留，未来 /settings 设备列表显示。
  - `src/server/routes/auth.ts:272` `/api/auth/me` owner 分支改写
  - `src/server/server.auth-token.test.ts:189` 测试断言同步更新

- [x] P10. sidebar 主题切换恢复：feedback `2026-05-12T11-15-43-440Z`
  "现在的主题切换没了"。C5 期间为省 320px drawer 宽度删了 sidebar
  的 ThemeToggle（segmented control 撑爆），让 user 走 /settings 切，
  user 反馈不便。修复：`ThemeToggle` 新增 `ThemeCycleButton` icon-
  only 单按钮变体（lucide Sun/Moon/Monitor 跟 mode），click cycle
  auto → light → dark；放回 sidebar header label 和登出之间，
  h-7 w-7 不撑爆。segmented control 仍保留给 /login / /settings 宽
  layout

- [x] P9. dead pane mobile click 弹键盘修复：feedback
  `2026-05-12T10-57-33-860Z` "我在一个 dead session 里点击，会弹出
  键盘和输入光标"。Root cause: xterm.js 内部用 hidden HTMLTextAreaElement
  (`term.textarea`) 接 input，即使 `disableStdin: true` mobile touch
  仍 focus textarea → 系统弹软键盘 + caret。
  - 一开始用 container `pointer-events-none + select-none` — 用户
    反对"绕过 + 失去长按 copy"
  - 改成只 `term.textarea.style.display = 'none'`：textarea 无法
    被 focus，弹键盘问题消除；xterm DOM rows 仍 user-selectable，
    保留长按 copy
  - 再改用 `term.textarea.disabled = true`：语义更准确（input
    exists but disabled）；保留 textarea 在 layout 流中以防 xterm
    内部读 dimensions；同样阻止 focus 不弹键盘

- [x] P8. resume 失败修复 #2：feedback `2026-05-12T10-33-26-560Z`。
  P7 fix 后 WS found:true 但 cc 仍 4s 后 exit。Root cause: ccanywhere
  web id ≠ cc jsonl id when 原 session 是 resume mode。`ca8ede78`
  是 web id, 但它原本接续 cc jsonl `3b3d0de0` — cc jsonl 文件叫
  `3b3d0de0.jsonl`，没有 `ca8ede78.jsonl`。我 resume route 传
  `--resume ca8ede78` 让 cc 找不到 jsonl 自动 exit。修复：
  - `sessions-resume.ts` args 用 `stub.info.resumeSessionId ?? id`
    （cc 真 jsonl id），不是 web id
  - `manager.resumeDeadStub` spawn 时 resumeSessionId 字段同样用
    cc jsonl id（lock key 正确性，避免两个 web session 同 cc jsonl
    并发）

## Phase 6 — C6 End-to-end 集成测试

- [x] T6.1. `src/server/server.restart-recovery.test.ts`（新）：完整
  仿真重启路径——buildServer (registry1) → POST 创 session → kill
  PTY + detach + close app → new manager2 + new buildServer (同
  registry dir) → loadDeadStubs → GET /sessions 含 state='dead' →
  POST /resume → 201，原 id，state='idle'，mode='resume'，session
  转回 active 路径
- [x] T6.2. e2e 跨重启（本机 LaunchAgent 真实场景）— 留 user 手验：
  浏览器创 session → `launchctl kickstart -k gui/$(id -u)/com.<you>.
  ccanywhere` → 刷新浏览器看 list 含 dead → 进 dead session → 看最
  后一屏 → 点 Resume → terminal 恢复
- [x] T6.3. C6 commit + test:all (348 passed) + build:all + healthz 200 ✓ (637ed35)

## Phase 5.5 commit map（polish 单独 commit）

- P1-P4 dead pane 复用 active layout：4b517be
- P5 shutdown killAll + P6 dead pane xterm 渲染：d1412e8
- P7 删冲突 `--session-id`：401c4d6
- P8 resume 用 cc jsonl id：78666de
- P9 mobile 弹键盘修复 #1（pointer-events 路径，user 反对后回滚部分）：1bb121e
- P9 mobile 弹键盘修复 #2（textarea.disabled 保留长按 copy）：3a7e97b
- P10 sidebar 主题切换恢复（icon-only cycle）：f8f9957
- P11 /api/auth/me 返 username：f3a6549
- B11 backlog 跟进登记：78d924d

## Phase 7 — Ship

- [x] T7.1. spec delta：新建 `openspec/specs/sessions/persistence.spec.md`
  含 "跨重启持久化（m-session-persistence）" Requirement（持久化存储 /
  boot 加载 / shutdown 时序 / resume 路径 / F1-F5 + 6 Scenario）；
  `sessions/spec.md` Purpose 段加 reference 指针。拆 sub-spec 是因
  Requirement 体量让 spec.md 超 600 行 lint cap
- [x] T7.2. archive：`mv openspec/changes/m-session-persistence
  openspec/archive/2026-05-13-m-session-persistence`
- [x] T7.3. tasks.md 回填 phase commit hash（C1-C6 + 9 项 P 5.5 polish
  见上"Phase 5.5 commit map"）
- [x] T7.4. BACKLOG.md 加 follow-up：
  - B12 Level 2 scrollback 持久化
  - B13 dead session retention policy
  - B11 cc-binary 集成 test 已在 78d924d 先行登记

## Commits

- (no matching commits found in git log)
