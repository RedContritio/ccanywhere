# Sessions — 跨重启持久化

跨 server 重启的 session metadata + 最后一屏持久化与 resume 路径。本文件
是 [spec.md](./spec.md) 的延伸（拆出避免 600 行 lint cap），对应 ship
为 m-session-persistence。

## Requirements

### Requirement: 跨重启持久化（m-session-persistence）

ccanywhere server 重启后 sessions list MUST 保留之前的 session，以
**dead** 状态加载入 list。user 点进 dead session MUST 能看最后一屏
snapshot，并通过显式 Resume 触发 spawn `--resume <id>` 接续 cc
conversation。boot-time **MUST NOT** 自动 spawn dead sessions（避免
N×cc 启动开销 + 失败 blast radius）。

#### 持久化存储

`SessionRegistry` MUST 在 `<configDir>/sessions/` 目录下持久化两类
文件：

- `<id>.json`：SessionInfo metadata + `deletedAt` 字段
- `<id>.screen.txt`：dead 时落盘的 last screen snapshot（含 ANSI
  control / cursor 位置 / alt-screen marker 等，由 `SerializeAddon`
  输出）

active session 写入路径：spawn 成功 MUST `void registry.save(info,
null)`；markDeleted 后 MUST `void registry.save(info, deletedAt)`。
写盘 MUST 是 fire-and-forget（libuv pool），main loop 不阻塞 user
response；失败 MUST log 但不影响 caller 路径。

#### 同 id 写入串行（m-registry-write-queue）

同一 `<id>` 的 mutating writes（save / saveScreen / delete /
deleteScreen）MUST 在 registry 内部串行执行 —— 同一 id 的并发 writeFile
非原子（truncate + write），繁忙时交错损坏文件。registry 维护
`writeChains: Map<id, Promise>`，新 op 链到 prev 之后；prev 失败 MUST
NOT 阻断同 id 后续 ops；chain settle 后自动 GC。跨 id MUST 仍并发，
throughput 不退化。

#### Boot 时加载

`serve.ts` listen 之前 MUST `manager.loadDeadStubs()` (sync) 扫描
`<configDir>/sessions/`：

- 每个 `<id>.json` corrupt / 缺失 → skip（不 crash boot）
- 已超 `deletedSessionTtlMs` 的 B 类（user DELETE）记录 → unlink
  metadata + screen file，不入 deadStubs map
- 其余记录入 `deadStubs: Map<id, DeadStub>`

#### Shutdown 时序

shutdown 路径 MUST 显式 `manager.killAll()` 主动 SIGINT 各 PTY，
然后 await 每个 onExit 触发 `handleSessionExit` 写入 snapshot pending
writes，最后 `manager.detach()` drain pending writes 才退出
process。MUST NOT 只 detach 然后 `process.exit(0)` —— event loop
终止后 onExit handler 永不执行，snapshot 永不落盘。

#### Resume 路径

POST `/api/sessions/:id/resume` MUST：

- dead stub 不存在 → 404
- session 已在 active map → 409 `already_active`
- `deletedAt !== null` → 409 `soft_deleted`
- cross-user → 404（不泄漏存在性）
- project 已 hide → 404 `project_gone`
- spawn 失败 → 500 `resume_failed`，dead stub 保持 dead（user 可重试 /
  删除）
- 成功 → 201 + 转回 active 路径的 Session row

resume spawn args MUST 用 cc jsonl id 而非 ccanywhere web id —— 当
原 session 是 resume mode 创建（DeadStub.info.resumeSessionId 指向
另一 cc jsonl）时，传入 `--resume <cc_jsonl_id>`（不是 web id），
否则 cc 找不到 jsonl 自动退出。**MUST NOT** 同时传 `--resume <id>`
和 `--session-id <id>`（cc 视为冲突 panic）。

cc args 构造 MUST 走纯函数 `buildResumeArgs(opts: { webId, resumeSessionId
})` (`src/session/resume-args.ts`，m-resume-args-helper)。route MUST NOT
inline 构造 `['--resume', ...]` 数组——把 cc args 形状放在可单测的纯函数
里，避免 sh-fixture 整合测试漏抓 args 形状 regression（m-session-persistence
P7 / P8 教训）。

GET `/api/sessions/:id/screen` MUST 返回 dead stub 的 last screen
snapshot 作为 `text/plain`。

#### Dead pane DOM renderer（m-dead-pane-touch-select P6）

xterm canvas / WebGL render 是 pixel image，mobile 长按其上得不到
native selection handles（系统级 selection 只在 native HTML 文本元素
上生效）。

历史演进:
- P4 试过 xterm canvas + 透明 `<pre>` overlay 叠层 — alignment 在高 dpr
  sub-pixel 失败 + overlay `z-index/pointer-events` 拦截 sibling UI。
- P5 改纯 plain text `<pre>` — alignment ok 但失 ANSI colors，user 仍
  反馈 mobile 高 dpr 下视觉对齐感不准。
- P6 用 xterm 自身默认 DOM renderer — cells 是 native HTML `<span>` w/
  inline fg/bg color，xterm 自算 cell metrics 保 alignment + ANSI
  colors，但 mobile 长按偶尔失败 (race)。
- P7（当前）补 capture-phase mouse* stop —— xterm SelectionService
  `handleMouseDown` 显式 `event.preventDefault()` 阻止 browser native
  selection，mobile touch→mouse 翻译时 xterm listener race winning 让
  selection 偶尔被 block。dead pane container 装 capture-phase mousedown
  / mousemove / mouseup / contextmenu listener `stopImmediatePropagation`
  切断 xterm 所有 mouse 路径。

实现要点:

- `DeadSessionSnapshot` mount xterm to container 调 `t.open(container)`
  + `t.write(snapshot)`，**不** loadAddon `WebglAddon` / `CanvasAddon`
  → xterm 用默认 `DomRenderer`（cells 渲染为 `<span class="xterm-fg-X
  xterm-bg-Y">char</span>`）。
- container 标 `data-dead-pane="true"` 让 CSS override 生效。
- `xterm-overrides.css` 加 scoped 规则:
  - `[data-dead-pane="true"] .xterm, [data-dead-pane="true"] .xterm *
    { user-select: text; -webkit-touch-callout: default; }` — 解锁
    `xterm.css` 默认的 `.xterm { user-select: none }`，让 spans 能被
    mobile 系统级长按 select；active pane 不受影响（仍用 xterm
    SelectionService drag）。
  - `[data-dead-pane="true"] .xterm-viewport { touch-action: auto }`
    — 解开 active pane 的 `touch-action: none`（dead pane 不滚动，
    不需要 block OS gesture）。
- dead pane container 装 capture-phase listener stop `mousedown` /
  `mousemove` / `mouseup` / `contextmenu`，切断 xterm SelectionService
  + coreMouseService 所有 mouse 路径。touch events 不动让 mobile OS
  长按 selection 走 native HTML path。
- xterm helper textarea `disabled = true` 防 mobile tap 弹软键盘。
- 不调 P2 mouse-mode reset escape (`\x1b[?...l`) —— P7 capture-phase
  stop 让 SelectionService 完全看不到 mousedown，是否 enabled 无关。

Trade-off: DOM renderer 性能比 WebGL 差（~700ms 首次 paint on mobile），
但 dead pane snapshot 是 static one-shot 不滚动，性能 cost 可接受。

`FONT_FAMILY_DEFAULT` 常量在 `terminal-config.ts` export，active pane
xterm + dead pane xterm 共用同字体栈。

#### Dead pane 必须 reset mouse mode（m-dead-pane-touch-select P2）

cc TUI 通常启用 xterm mouse-mode（DEC private mode `?1000` / `?1002`
/ `?1006` 等）让 cc 自己捕获 click。SerializeAddon 把这个 state 写
进 snapshot；dead pane `t.write(snapshot)` 时 xterm 触发
`coreMouseService.onProtocolChange` → `SelectionService.disable()`，
disabled 状态下 mousedown 不进 `_handleSingleClick`，长按合成 touch
无 modifier → `selectionStart` 不被设 → 选择无效。

`DeadSessionSnapshot` MUST 在 `t.write(snapshot)` 之后立即 write
`\x1b[?9;1000;1001;1002;1003;1004;1005;1006l` 重置所有可能开启的
mouse-mode DEC private mode，让 SelectionService 重回 enabled 状态，
长按 / 双击 / drag-select 才能工作。

#### 形式化保证

- F1. active session 在 metadata 目录 MUST 有且仅有一个 `<id>.json`
  file（spawn 写 / hard delete 删）。
- F2. dead session MUST 有 `<id>.json` + `<id>.screen.txt` 两个 file
  （onExit 写 screen，spawn → dead 是单向）。
- F3. 重启前后 sessions list 内容 MUST 等价：active 变 dead（state
  改变）；dead 保留；deletedAt 超 ttl 的 B 类被 hard delete。
- F4. GC ttl MUST 跨重启延续：deletedAt 持久化在 metadata，
  loadDeadStubs 时已超 ttl 直接 unlink，不入 deadStubs。
- F5. resume 后 dead stub 转 active：ccanywhere web id 不变（cc
  jsonl 文件名稳定），resume lock 自动重建，旧 screen.txt MUST 删除
  （snapshot 失效）。
- F6. 同一 `<id>` 的 mutating writes MUST 串行执行（m-registry-write-
  queue）。
- F7. 不同 id 的 writes MUST 仍可并发。
- F8. chain 中某 op 抛异常 MUST NOT 阻塞同 id 后续 ops。

#### Scenario: 重启后 session 仍可见为 dead

- GIVEN server 跑 2 个 idle session A / B
- WHEN  server `killAll` → `detach` → exit，再启动新 server 同
  `<configDir>`
- THEN  `loadDeadStubs` 把 A / B 入 `deadStubs` map
- AND   GET /api/sessions 返回 A / B 行，`state === 'dead'`
- AND   `<configDir>/sessions/A.json` + `A.screen.txt` 仍存在

#### Scenario: dead session 看最后一屏

- GIVEN A 是 dead stub
- WHEN  GET /api/sessions/A/screen
- THEN  返回 200 + `text/plain` body 含 dead 时 ScreenState snapshot
  文本（feed 进 xterm 后渲染等同 active 末帧）

#### Scenario: Resume 转 active 单向

- GIVEN A 是 dead stub
- WHEN  POST /api/sessions/A/resume 成功
- THEN  201，response.id === A
- AND   manager `sessions` 含 A，`deadStubs` 无 A
- AND   `<configDir>/sessions/A.screen.txt` 已删除
- AND   后续 GET /sessions 中 A 显示 `state === 'starting'` 或
  `'idle'`，不再是 dead

#### Scenario: Resume cc jsonl id 不等于 web id

- GIVEN A 是由 resume mode 创建（A.info.resumeSessionId = `cc_X`，
  cc jsonl 文件名 `cc_X.jsonl`）
- WHEN  POST /api/sessions/A/resume
- THEN  spawn cc 时 args 含 `--resume cc_X`（不是 `--resume A`）
- AND   args 不含 `--session-id A`（避免 cc 冲突 panic）

#### Scenario: buildResumeArgs regression guard

- WHEN  调 `buildResumeArgs({ webId, resumeSessionId })` 任意输入
- THEN  返回数组形如 `['--resume', ccSessionId]`，长度 2
- AND   `ccSessionId === resumeSessionId ?? webId`
- AND   数组 MUST NOT 含 `'--session-id'`

#### Scenario: 同 id 并发 writes 不损坏文件

- GIVEN registry 同一 id 100 次并发 `save(info, i)`（i 递增）
- WHEN  await Promise.all 全部完成
- THEN  `<id>.json` 内容是 valid JSON
- AND   `deletedAt === 99`（最后一次 issue 的值）

#### Scenario: 跨 id writes 仍并发

- GIVEN registry 对 id=A 的 save 正在 await（slow IO）
- WHEN  对 id=B issue save
- THEN  B 的 op MUST NOT 等待 A 的 chain
- AND   B 可以与 A 并行执行

#### Scenario: shutdown 写入 snapshot

- GIVEN server 跑 1 个 idle session A
- WHEN  shutdown 路径触发：`manager.killAll()` → 各 PTY 收 SIGINT
- THEN  A 的 `pty.onExit` 触发 `handleSessionExit`
- AND   `screenState.snapshot()` 文本入 pendingWrites
- AND   `manager.detach()` await 所有 pendingWrites settle
- AND   process exit 前 `<configDir>/sessions/A.screen.txt` 已落盘

#### Scenario: GC ttl 跨重启延续

- GIVEN session A 被 markDeleted（deletedAt = T0），ttl = 10 min
- WHEN  server 在 T0+5min shutdown，T0+15min 启动新 server
- THEN  loadDeadStubs 见 A.json deletedAt + ttl < now
- AND   unlink `A.json` + `A.screen.txt`
- AND   A 不入 deadStubs，不出现在 list 中
