# Web Frontend

## Purpose

ccanywhere 的服务端只提供 REST 与 WebSocket 端点；要让人在浏览器里用，需要一个
独立的前端项目。这个 capability 描述 `web/` 子目录下的 React + Vite SPA：
登录流、workspace 主界面、session 列表与新建对话框、xterm.js 终端、移动端
虚拟工具栏、主题（auto/light/dark）切换、客户端 Idempotency-Key 策略，以及
react-router 路由约定。

终端视图、renderer 选择、dims state machine、placeholder、键盘 overlay、
文本选择 / 触摸滚动、客户端诊断 (diag)、移动端虚拟工具栏 8 个 Requirement
拆分到 [terminal.spec.md](./terminal.spec.md)。

## Requirements

### Requirement: 前端入口与构建

ccanywhere 仓库 MUST 在 `web/` 子目录下提供一个独立的 React + Vite 前端项目。
该项目 MUST：

- 使用 TypeScript strict 模式（与 server tsconfig 独立）。
- 用 Vite 构建，产物输出到 `web/dist/`。
- dev 期间 Vite 5173 端口 + 代理 `/api`、`/ws` 到 fastify 监听端口。
- 不引入 monorepo workspace 配置（独立 `package.json` 与 `node_modules`）。

#### Scenario: 开发模式可访问

- GIVEN ccanywhere server 运行在 62275，`pnpm -F ccanywhere-web dev` 启动
- WHEN  浏览器访问 `http://localhost:5173/login`
- THEN  登录页正常加载
- AND   页面对 `/api/projects` 的请求被 Vite proxy 到 62275

### Requirement: 设备配对与登录

前端 MUST 不让用户输入 token——身份通过 WebAuthn pair / login 流程建立。
完整流程见 `openspec/specs/auth/spec.md` "设备配对（Pair）"与"设备登入
（Login）"。

UI 层面 MUST：

- 首次访问（无 cookie）显示设备配对页：用户填一个 `label`（设备人类标签），
  点击"开始配对"触发 `POST /api/auth/register-init` →
  `navigator.credentials.create()` → `POST /api/auth/register-complete` →
  long-poll `GET /api/auth/register-status?pendingId=…` 直到 mac 端 approve。
- 已配对设备的浏览器（cookie 在但已 expire）显示登录页：选择 deviceId →
  `POST /api/auth/login-init` → `navigator.credentials.get()` →
  `POST /api/auth/login-complete`。
- 鉴权 MUST 完全依赖浏览器自动随请求带的 same-origin
  `ccanywhere_session=<id>` HttpOnly cookie。前端 MUST NOT 在
  `Authorization: Bearer ...` 中带 token，MUST NOT 把鉴权类凭证写入
  localStorage。

收到 `401` 响应时 MUST 跳回登录页（让用户重新走 WebAuthn login）。
localStorage 仍 MAY 保存 UI prefs（theme、上次 sessionId 等），但 MUST NOT
保存任何鉴权凭证。

#### Scenario: 401 触发跳回登录

- GIVEN 用户的 cookie 已在服务端 revoke
- WHEN  前端发出任何 `/api/*` 请求
- THEN  收到 401
- AND   页面跳到 `/login`（或配对页，依本地是否有已记的 deviceId）
- AND   localStorage 中的 UI prefs MAY 保留

### Requirement: Idempotency-Key 客户端策略

前端 MUST 为每个 `POST /api/sessions` 调用自动生成 `Idempotency-Key`,
值为 `crypto.randomUUID()`。同一 UI 操作（用户点击"新建对话"按钮一次）
内的所有重试 MUST 复用同一 key——重试时 server 命中缓存返回相同结果。

key 在该操作完成（成功或 fatal 错误）后失效，下次操作生成新 key。

#### Scenario: 重试用同一 key

- GIVEN 用户在新建对话框点击"创建"，第一次请求超时
- WHEN  用户点击"重试"
- THEN  第二次请求带的 `Idempotency-Key` 与第一次相同
- AND   服务端返回 `Idempotency-Replayed: true`
- AND   仅创建了一个 session

### Requirement: Session 列表与 deleted 视觉

主界面 MUST 显示当前 token 视角下的所有 session（来自 `GET /api/sessions`），
按 `createdAt` 倒序。每条目 MUST 显示：

- 项目名（由 projectId 在客户端缓存的 projects 中查找）
- 创建时间（人类可读相对时间）
- 状态徽标（colored chip：idle 绿、busy 黄、dead 灰）
- 若 `deletedAt !== null`：整行半透明，附"已删除"标签，仍可点击查看
  scrollback 历史。

#### Scenario: 软删除的 session 仍可见

- GIVEN 用户对某 session 调过 DELETE
- AND   该 session 在服务端 `deletedSessionTtlMs` 内未被 GC
- WHEN  用户回到主界面
- THEN  session 行仍出现在列表中
- AND   行视觉上明显区别（半透明 + 标签）

### Requirement: 新建 session 携带当前主题

`POST /api/sessions` 的请求 body MUST 含 `webTheme`，取值为
`useEffectiveTheme()` 当前 hook 返回（`'dark'` 或 `'light'`）。这让服务端
按当前 effective theme 给 cc 子进程注入 `COLORFGBG`（见
`openspec/specs/rest-api/spec.md` "POST /api/sessions"）。

UI 层面 effective theme 变化（包括 auto 模式时间触发）后 MUST NOT 重发已存在
session 的 `webTheme`——env 注入仅作用于新 spawn。已存在 session 的主题
切换由后续 reload 机制覆盖（暂未实现）。

`POST /api/sessions { mode: 'resume', sessionId: X }` 当服务端命中已被占用
的 cc-X 时返 `200` + 现有 web-session 行（详见
`openspec/specs/rest-api/spec.md` "POST /api/sessions" 与
`openspec/specs/sessions/spec.md` "resume 唯一性"）。客户端 MUST：

- 不论 server 返 `200` 还是 `201`，从 response body 取 `id` 字段作为
  `currentSessionId`。
- 调 `navigate(/workspace/<id>)`。
  - 若当前 path 已是 `/workspace/<id>`（同 device 二次 resume 同 cc-X 命中
    自己已经在看的 W），react-router-dom v6 默认 navigate 到当前 path 是
    no-op，TerminalView `key={W}` 不变 → 不 unmount → ws 连接保留 → 体感
    "对话框关闭，仍在原终端"。
  - 若不是当前 path（不同 device 或同 device 但当前在别的 W），navigate
    切换到该 W → TerminalView mount → ws connect → 加入 multi-client
    broadcast。
- 200 与 201 schema 一致，client 无需按 status 区分逻辑。

#### Scenario: 新建会话带 webTheme

- GIVEN useEffectiveTheme 返回 `'light'`
- WHEN  用户点击"新建会话"提交
- THEN  `POST /api/sessions` body 含 `"webTheme": "light"`

#### Scenario: 同 device 同 W resume 不重 mount

- GIVEN 用户当前在 `/workspace/W1`，TerminalView 已 mount，ws active
- AND   W1 是由 resume cc-X 创建的
- WHEN  用户在 history 列表点 cc-X 触发新 resume → POST 返 `200` + W1
- AND   client 调 `navigate('/workspace/W1')`
- THEN  react-router 因 path 不变 navigate 是 no-op
- AND   TerminalView `key={W1}` 不变，组件不 unmount / remount
- AND   ws 连接持续保留（不重连）

#### Scenario: 不同 device resume 走 multi-client broadcast

- GIVEN device A 在 `/workspace/W1`（W1 是 cc-X 的 resume），ws 1 已 active
- WHEN  device B 在 history 点 cc-X resume → POST 返 `200` + W1
- AND   B 的 client 调 `navigate('/workspace/W1')`，TerminalView mount，ws 2 connect
- THEN  ws server `bundle.clients.add(B_sock)`
- AND   B 收到 W1 的当下 screenState snapshot
- AND   后续 PTY 输出同时广播给 A 和 B 的 sock
- AND   A 与 B 都能 input 写到 W1 的 cc 进程（ws-protocol 多 client 广播
        语义）

### Requirement: WebSocket 重连协议（lastSeq）

客户端 TerminalSocket MUST 维护 `lastSeq: number`，初始 `0`。每次收到
`snapshot { upToSeq, data }` 或 `output { seq, data }` 帧 MUST 把对应字段
赋给 `lastSeq`。每次 reconnect MUST 在 ws URL 拼 `?lastSeq=<lastSeq>`
（仅当 `lastSeq > 0`；为 0 时省略）。

服务端按 `?lastSeq=N` 协商 incremental 或 fallback snapshot 的逻辑见
`openspec/specs/ws-protocol/spec.md`。客户端无需关心服务端选哪条路径——
按帧类型反应即可（snapshot 帧 reset+write、output 帧 append-write）。

### Requirement: 用户反馈渠道

前端 MUST 提供两条反馈路径，均通过 `POST /api/feedback`（见
`openspec/specs/rest-api/spec.md`）落盘：

1. **手动反馈**：drawer 底部"反馈"按钮 → 反馈 dialog（标题必填、正文可选、
   ops 自动附 + diag 自动附）→ 用户提交。
2. **崩溃自动反馈**：React `ErrorBoundary` `componentDidCatch` 时 MUST
   fire-and-forget 调用 `POST /api/feedback`，title 为错误 message、body 为
   stack、ops 附 ErrorBoundary 捕获瞬间的 ops-log snapshot、diag 附捕获瞬间
   的客户端诊断现场。失败时 UI 显示"重试反馈"按钮；不阻塞 fallback UI 渲染。

ops-log MUST 是 module-scoped 环形缓冲区。容量 `N` 由保留窗口与峰值事件
密度推导：`N = ceil(RETENTION_WINDOW_S × PEAK_EV_PER_S × HEADROOM)`。
基线 `RETENTION_WINDOW_S = 60`（用户感知问题到打开反馈 dialog 的合理上限）、
`PEAK_EV_PER_S = 90`（dominant 源 `term.write` ≤ outputFps 60/s 加上限频
后的 touch/mouse/selection 事件 ~30/s）、`HEADROOM = 1.2`，对应 `N ≈ 6480`。
单 op JSON ~120 B，POST body 上限 ~780 KB（fastify 默认 1 MB 兜底）。
未来调整保留窗口或峰值上限时只需改输入，不要直接调容量。
`recordOp(kind, payload?)` MUST 在以下时机被调用：

- session 生命周期事件（`session.create`、`session.delete`）
- terminal renderer 切换（`terminal.renderer`）
- React `componentDidCatch`（`react.error`）
- `window.onerror`（`window.error`）
- `window.onunhandledrejection`（`window.unhandledrejection`）
- WebSocket 生命周期（`ws.connect`、`ws.close`、`ws.reconnect`）
- WebSocket 帧错误（`ws.frame.error` —— 解析失败 / 未知 type）
- 终端写入错误（`term.write.error` —— `chunkedWrite` 抛异常）
- 终端写入轨迹（`term.write` —— `chunkedWrite` 入口，含 `source`
  `'snapshot' | 'output'` / 当前 `buf.type` / `len` / `chunked?`）
- 终端 reset（`term.reset` —— `onSnapshot` 触发）
- 终端 buffer 切换（`term.buffer.change` —— alt-screen 进/出）
- 终端 selection 变化（`term.selection` —— xterm `onSelectionChange`，
  含 `empty` / `len` / `sample`）
- 终端 resize（`term.resize` —— `fit.fit()` 后 cols/rows 真的变化时；
  payload 含 `from` / `to`）
- 触摸事件（`touch.start` / `touch.end` / `touch.drag.start` /
  `touch.drag.move` / `touch.pinch`）
- mouse capture（`mouse.down` —— container 上 capture-phase 监听，
  payload 含 `targetClass` / `button` / `buttons`）

`ws.reconnect` 调用 MUST 限频到至多 1 次/秒（避免 backoff 8s 窗口期内的
反复 schedule 把 ops 全填满）。

高频事件（`touch.drag.move` / `touch.pinch` / `mouse.down`）MUST 使用
`recordOpThrottled(kind, payload, intervalMs)` 限频，建议 `intervalMs` 取
`50` ~ `100` —— 用最近样本而非完整流，让有限的 ring 容量优先承载用户
触发链而非单帧密集事件流。

drawer 底部 MUST 同时提供"刷新"按钮（除"反馈"按钮之外），点击调
`location.reload()`。提供该入口的原因：cc Ink TUI 在 SIGWINCH 后会把
当前可见 grid 内容追加进 scrollback 而非清掉重画（上游
`anthropics/claude-code#49086`），mobile 上几次 resize 之后 scrollback
里能堆出多份重复 banner。整页 reload 让 client `term.reset()` + 服务端
`screenState.snapshot()` 重新发出"当下应有的屏幕"，是上游修复落地前
最便宜的临时缓解。该按钮 MUST NOT 删除 session 或重启 PTY——只是
重连同一 session id 的 WS 通道。

#### Scenario: 崩溃自动上报含诊断现场

- GIVEN React 渲染中抛错，反馈服务正常
- WHEN  ErrorBoundary 捕获
- THEN  自动 `POST /api/feedback` body 含 `title`、`body` (stack)、
        `ops` (recent snapshot)、`diag` (`viewport` / `net` / `app` /
        `ws` / `term` / `memory` 各字段 best-effort 收集)
- AND   UI 渲染 fallback（不白屏），不阻塞用户继续操作其它 session

#### Scenario: drawer 刷新按钮不删 session

- GIVEN 当前 workspace 在 session `S` 上
- WHEN  用户点 drawer "刷新"
- THEN  浏览器 reload，重新加载 SPA
- AND   重新进入同一 `/workspace/<S>` 路由
- AND   server 端 manager 中 `S` 行未被删除（重连同一 ws 通道）

### Requirement: 主题（auto / light / dark）

前端 MUST 提供三态主题：

| 模式 | effective theme |
|------|----------------|
| `auto` | 本地时间 07:00–18:59 用 `light`，其它时段用 `dark` |
| `light` | 强制 `light` |
| `dark` | 强制 `dark` |

默认 `auto`，持久化到 localStorage（与其它 UI prefs 共用 `ccanywhere.ui`）。

主题切换 UI MUST：

- 顶部 header 含一个图标按钮，单击 cycle `auto` → `light` → `dark` → `auto`。
- 按钮 MUST 显示当前 **effective** theme 的图标 + 当前 **mode** 的角标
  （区分"现在是亮"和"模式是 auto"）。

实现 MUST：

- 把 effective theme 写到 `document.documentElement.dataset.theme`，CSS 用
  `:root[data-theme="dark"]` 形式定义两套 CSS 变量。
- xterm.js 主题与全局主题保持一致——effective theme 切换时同步更新
  `term.options.theme`。
- `auto` 模式下每 60 秒重新计算 effective theme，覆盖天黑/天亮无须手动刷新；
  `light` / `dark` 不开此 interval。

#### Scenario: auto 模式按时切换

- GIVEN themeMode 为 `auto`，本地时间 07:30
- WHEN  界面渲染
- THEN  `document.documentElement.dataset.theme === "light"`
- AND   xterm.js 使用浅色主题

#### Scenario: 用户手动覆盖

- GIVEN themeMode 为 `auto`，effective 为 `dark`
- WHEN  用户点切换按钮一次（cycle 到 `light`）
- THEN  themeMode 更新为 `light`
- AND   effective theme 立即变为 `light`，与本地时间无关
- AND   localStorage `ccanywhere.ui` 反映 `themeMode === "light"`

#### Scenario: 重启浏览器后保持选择

- GIVEN 用户上次选择 `dark` 模式
- WHEN  关闭并重新打开浏览器，访问应用
- THEN  themeMode 从 localStorage 恢复为 `dark`

### Requirement: 路由

前端 MUST 使用 `react-router-dom` v6，至少包含以下路由：

| 路径                    | 行为 |
|-------------------------|------|
| `/login`                | 登录页 |
| `/workspace`            | 主界面，session 未选中 |
| `/workspace/:id`        | 主界面 + 选中某 session |
| `/history`              | 占位（M7/M8 实现），目前 redirect 到 `/workspace` |
| `/settings`             | 占位（M7/M8 实现），目前 redirect 到 `/workspace` |
| 其它任意路径             | 重定向到 `/workspace` 或 `/login`（视登录态） |

未登录访问任何非 `/login` 路径 MUST 跳到 `/login`。

### Requirement: 浏览器桌面通知

前端 MUST 在 workspace 页面提供"开启桌面通知"的引导条（仅当
`Notification.permission === 'default'` 时显示），点击 "开启" 调用
`Notification.requestPermission()`。

权限被授予（`granted`）后，前端 MUST 监听 sessions store 中每个 session 的
`state`，在以下条件**全部**满足时调用 `new Notification(...)` 弹桌面通知：

- session.state 由 `busy` 变为 `idle`
- session.id ≠ `useUiStore.currentSessionId`（当前未选中）
- `document.hidden === true`（tab 不在前台）

通知 MUST 满足：

- title 为 "cc 完成响应"。
- body 包含 session 对应 project 的人类可读名（fallback 到 `projectId`）。
- `tag` 为 `ccanywhere-<sessionId>`，让浏览器自动用同 tag 的新通知替换旧的，
  避免桌面堆积多条。

通知点击事件 MUST：

- 调用 `window.focus()` 把当前 tab 提到前台。
- 通过 react-router `navigate(`/workspace/:id`)` 切到该 session。
- 调用 `notification.close()`。

#### Scenario: default 状态显示 banner，granted 不显示

- GIVEN `Notification.permission === 'default'`
- WHEN  workspace 页面渲染
- THEN  banner 可见，含"开启"按钮
- GIVEN `Notification.permission === 'granted'`（用户已开过权限或别处授权）
- WHEN  workspace 页面渲染
- THEN  banner 不显示

#### Scenario: 通知触发条件全满足

- GIVEN 用户在 `/workspace/A`，sessionB.state 之前是 `busy`，权限已授予
- AND   切到别的 tab（document.hidden = true）
- WHEN  sessionB.state 变为 `idle`（来自 hook receiver）
- THEN  浏览器弹桌面通知
- AND   tag 为 `ccanywhere-<B.id>`

#### Scenario: 当前选中的 session 不弹通知

- GIVEN 用户在 `/workspace/A`，权限已授予，document.hidden 为 true
- WHEN  sessionA.state 由 busy 变 idle（用户当前选中的）
- THEN  不发通知（用户已经在看这个）

#### Scenario: tab 可见不弹通知

- GIVEN 权限已授予，document.hidden = false
- WHEN  非选中 session 由 busy 变 idle
- THEN  不发通知（tab 已在前台）

### Requirement: 后台 sessions 轮询

前端 MUST 在 `document.hidden === true` 时每 5 秒调用一次
`fetchSessions()`，让非选中 session 的 state 变化能被前端看到。
`document.hidden === false` 时 MUST 停止该轮询。

理由：当前架构下非选中 session 没有 WebSocket 连接，state 变化只能通过
`/api/sessions` 拉取得知。轮询限制在后台 tab 是节流——前台时 user 自己看
着不需要刷。

#### Scenario: 切到后台启动轮询

- GIVEN tab 在前台，无 setInterval
- WHEN  tab 切到后台（visibilitychange → hidden）
- THEN  启动 5s interval，每次 tick 调 fetchSessions

#### Scenario: 切回前台停止轮询

- GIVEN 后台轮询正在跑
- WHEN  tab 切回前台
- THEN  clearInterval，不再 fetch
