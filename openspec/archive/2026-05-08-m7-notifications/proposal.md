# Proposal: M7 — 浏览器桌面通知

## Intent

到 M6 为止，session 列表与终端在 web 上完整可用，但 user 切到别的 tab 后
session 完成 cc 响应时**没有任何提醒**——这是 ccanywhere 作为"远程入口"
最关键的可发现性能力。M7 引入浏览器 Notification API：cc turn 结束（hook
驱动 busy → idle）且当前 tab 不可见时，弹一条桌面通知，点击聚焦该 session。

## Scope

包含：

- `<NotificationBanner>` 组件：仅在 `Notification.permission === 'default'`
  时显示一条邀请条 + "开启"按钮；点击后调用 `Notification.requestPermission()`。
- `useCompletionNotify(navigate)` hook：监听 sessions store 的 state 变化，
  在 `busy → idle && id ≠ currentId && document.hidden` 时发通知；点击通知
  `window.focus()` + 路由跳到该 session。
- `useBackgroundPoll()` hook：tab 不可见时每 5s 轮询 `/api/sessions`（让
  非选中 session 的 state 变化能被前端看到）；tab 可见时停止轮询。
- 工程上 `Notification` 的健壮回退：未受支持 / 被拒时 banner 自动隐藏并
  不抛错。

不包含（保持现状或留后续）：

- 后端 broadcast WebSocket（多 session 实时推 state 变化）——M-frp 的简化
  TCP 拓扑下 5s 轮询足够；后续升级到 https + 多端同时使用时可考虑。
- Service Worker / Web Push（关页面/锁屏也能收）——M6 显式选了 "浏览器原生
  Notification 即可，不要 Web Push"，本提案保持。
- iOS Safari 的 Notification 限制（仅 PWA 安装态可用）——文档级提示，不在
  代码里处理。

## Approach

**banner 仅一次性出现**：state === 'default' 时显示；'granted' / 'denied'
/ 'unsupported' 都不显示。"denied" 用户得自己改浏览器设置；ccanywhere 不试图
重复弹权限请求。

**轮询而非 WS broadcast**：simplest path。tab 不可见 → setInterval 5s 调
fetchSessions；tab 可见 → clearInterval。idle tab 每分钟才 12 个轻量 GET，
开销可忽略。后端 0 改动。

**通知 tag 防刷屏**：通知 tag 为 `ccanywhere-<sessionId>`，浏览器自动用同
tag 的新通知替换旧的——即使 hook 发了多次 busy→idle，桌面同时只有一条。

**点击聚焦**：`window.focus()` 在多 tab 浏览器把当前 tab 提到前台；之后
react-router 的 `navigate(`/workspace/:id`)` 把 url 切到目标 session。如果
当前已经在 `/workspace/:other-id`，点通知会切到通知里那个 session。

**hook 是前置条件**：M-hook-opt-in 后默认部署不发 hook → 不会有 busy 状态
→ 通知永远不会触发。M7 装的是基础设施；user 自己配 hook 后才看到效果。
M8 文档会把这个串联起来。
