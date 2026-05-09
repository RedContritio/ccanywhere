## MODIFIED Requirements

### Requirement: 用户反馈渠道

前端 MUST 提供两条反馈路径，均通过 `POST /api/feedback`（见
`openspec/specs/rest-api/spec.md`）落盘：

1. **手动反馈**：drawer 底部"反馈"按钮 → 反馈 dialog（标题必填、正文可选、
   ops 自动附 + diag 自动附）→ 用户提交。
2. **崩溃自动反馈**：React `ErrorBoundary` `componentDidCatch` 时 MUST
   fire-and-forget 调用 `POST /api/feedback`，title 为错误 message、body 为
   stack、ops 附 ErrorBoundary 捕获瞬间的 ops-log snapshot、diag 附捕获瞬间
   的客户端诊断现场。失败时 UI 显示"重试反馈"按钮；不阻塞 fallback UI 渲染。

ops-log MUST 是 module-scoped 环形缓冲区（最近 N 条，N MAY 取 50）。
`recordOp(kind, payload?)` MUST 在以下时机被调用：

- session 生命周期事件（`session.create`、`session.delete`）
- terminal renderer 切换（`terminal.renderer`）
- React `componentDidCatch`（`react.error`）
- `window.onerror`（`window.error`）
- `window.onunhandledrejection`（`window.unhandledrejection`）
- WebSocket 生命周期（`ws.connect`、`ws.close`、`ws.reconnect`）
- WebSocket 帧错误（`ws.frame.error` —— 解析失败 / 未知 type）
- 终端写入错误（`term.write.error` —— `chunkedWrite` 抛异常）

`ws.reconnect` 调用 MUST 限频到至多 1 次/秒（避免 backoff 8s 窗口期内的
反复 schedule 把 ops 全填满）。

#### Scenario: 崩溃自动上报含诊断现场

- GIVEN React 渲染中抛错，反馈服务正常
- WHEN  ErrorBoundary 捕获
- THEN  自动 `POST /api/feedback` body 含 `title`、`body` (stack)、
        `ops` (recent snapshot)、`diag` (`viewport` / `net` / `app` /
        `ws` / `term` / `memory` 各字段 best-effort 收集)
- AND   UI 渲染 fallback（不白屏），不阻塞用户继续操作其它 session

## ADDED Requirements

### Requirement: 客户端诊断收集（diag）

前端 MUST 在反馈提交（手动 dialog 或 ErrorBoundary 自动）时附加结构化
诊断信息，无需用户输入。`diag` 内容遵循
`openspec/specs/rest-api/spec.md` "POST /api/feedback" 中的 schema。

收集策略：

- **viewport**：`window.innerWidth/Height`、`window.devicePixelRatio`、
  `screen.orientation?.type`。当 active terminal 存在时，加 `cols` / `rows`
  （来自 `term.cols` / `term.rows`）。
- **net**：`navigator.onLine`、`navigator.connection.effectiveType` 与
  `downlink`（仅 Chrome 支持，其它浏览器留空）。
- **app**：`activeSessionId`（当前 workspace 路由的 sessionId）、
  `sessionIds`（zustand store 全列）、`theme`（`useThemeStore` 当前 mode）、
  `effectiveTheme`（`useEffectiveTheme()` 返回）。
- **ws**：active terminal 对应的 `TerminalSocket.getDiag()`：
  `readyState` / `lastSeq` / `retryIdx` / `lastFrameTs` / `lastFrameType`，
  并计算 `sinceLastFrameMs = Date.now() - lastFrameTs`。
- **term**：`rendererKind`（来自 mount 时记录的 picked renderer）、
  `lastWriteTs`、行级纯文本 `screen` (可见区 + 上方 `min(20, viewportY)`
  行 scrollback，每行 `term.buffer.active.getLine(i)?.translateToString(true)
  ?? ''`)。
- **memory**：`performance.memory` 三字段（仅 Chrome），`undefined` 时整段
  缺失。

active terminal 引用通过 module-scoped slot 维护：terminal 组件 mount 时
`setActiveTerm({term, ws, sessionId})`、unmount 时 `setActiveTerm(null)`。
非 workspace 页（登录/配对）的反馈 diag 中 `term` / `ws` 缺失，其它字段
（viewport / net / memory）仍收集。

#### Scenario: 手动反馈 dialog submit 附 diag

- GIVEN 用户在 workspace 看终端时打开反馈 dialog 填了 title 提交
- WHEN  前端发 `POST /api/feedback`
- THEN  body 含 `diag.viewport.cols/rows` 与 `diag.term.screen` 数组
- AND   body 含 `diag.ws.lastSeq`（≥ 0）与 `diag.ws.readyState`

#### Scenario: 登录页反馈无 term/ws 字段

- GIVEN 用户在登录页（无 active terminal）打开反馈 dialog 提交
- WHEN  前端发 `POST /api/feedback`
- THEN  body 含 `diag.viewport.windowW/H`（与 net/memory 字段）
- AND   body 中 `diag.term` 与 `diag.ws` 缺失或为空对象

#### Scenario: 隐私提示

- GIVEN 反馈 dialog 打开
- THEN  hint 文本 MUST 提示用户：提交时附最近操作记录、终端可见内容、
        浏览器与网络状态（让用户在敏感场景主动取消）
