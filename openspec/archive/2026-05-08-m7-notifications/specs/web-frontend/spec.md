## ADDED Requirements

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
