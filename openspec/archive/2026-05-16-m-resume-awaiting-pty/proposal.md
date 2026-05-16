---
status: in-flight
---

# Proposal: m-resume-awaiting-pty — resume/attach 等首字节 UI 中间态

## Intent

BACKLOG B18：dogfood 弱网下点 resume，WS upgrade 立刻成功 → terminal-header
chip 立刻显示 "已连接"，但 cc 进程 reload jsonl + 首条 PTY data 推过来要
数秒到数十秒。user 看到 "已连接" 但终端空白，以为 resume 失败。

UI 没区分 "WS 已建立"（onConnected） vs "PTY 数据已开始流"（首条 snapshot
/ output frame）。补一个 `awaitingFirstData` 中间态，chip 显示 "已连接，
等待 cc 输出…"，收到首条 snapshot/output 后切换 "已连接"。

## Scope

- `TerminalSocket` 加 `onFirstData` 一次性 callback；首次 `snapshot` 或
  `output` frame 触发（status/error/quota 不算"数据流"）
- `terminal-socket-setup.ts` / `terminal.tsx` 转发 `onFirstData`
- `workspace.tsx` 加 `awaitingFirstData` state，id 切换 / `connecting`
  时 reset 为 true，收到首数据 → false
- `wsConnLabel` 加 `awaitingData` 参数，`connected && awaitingData` →
  `'已连接，等待 cc 输出…'`，其余分支不变
- 测试：ws.test.ts 加 onFirstData 仅触发一次；ws-conn-label.test.ts 加
  awaiting 分支

## 决策

### D1. 中间态用 flag，不增 WsConnection 第 5 态

`WsConnection` 是 4 态机（connecting / connected / reconnecting / dead），
加 `'awaiting-data'` 会要 reconcile 与 `connected` 的关系（语义重叠：
WS 已连但数据未到 = "connected 的一个子相位"，不是平级 5 态）。用独立
`awaitingFirstData: boolean` 与 `wsConnection === 'connected'` 正交组合，
逻辑边界清晰。

### D2. 首数据定义：snapshot 或 output frame

`status` frame（busy/idle）/ `error` / `pong` / `quota_exhausted` 不算
"cc 已输出"——它们是控制帧，user 等的是终端可见内容。snapshot 是 reload
jsonl 后服务端推的"已渲染状态"，output 是 cc 后续 stream，二者任一首次
到达即满足语义。

### D3. `onFirstData` 一次性，TerminalSocket 内部 latch

TerminalSocket 持 `private firstDataDelivered = false`；dispatch snapshot/
output 前检查并 set true 后调一次 `handlers.onFirstData?.()`。reconnect
不 reset latch——一次 session lifecycle 内首字节意义是 "终端不再空白"，
后续重连用户已看到内容，不需要再降级 label。

### D4. id 切换 reset awaitingFirstData

workspace.tsx 现有 `useEffect([id])` reset `wsConnection / deadReason /
liveSessionState`；同一 effect 加 `setAwaitingFirstData(true)`。TerminalView
的 `key={currentSession.id}` 保证 socket 重建 + onFirstData latch 重新走。

### D5. `wsConnLabel` 接受 awaitingData 参数（不变向后改）

签名 `(c, reason)` → `(c, reason, awaitingData?)`。awaitingData 默认
undefined / false，老 caller 不破。仅 `c === 'connected' && awaitingData`
时返回 "已连接，等待 cc 输出…"，其他分支字面不变。

reconnecting 不显示 awaiting 字样——reconnect 期间用户已看到内容，"重连
中…" 已经足以表达"暂时无数据"。

## 落地点

| 文件 | 改动 |
|---|---|
| `web/src/ws.ts` | `SocketHandlers` 加 `onFirstData?: () => void`；`TerminalSocket` 加 `firstDataDelivered = false`；dispatch snapshot/output 时若未 delivered → set true + 调 onFirstData |
| `web/src/ws-conn-label.ts` | `wsConnLabel` 加 `awaitingData` 参数；connected 分支按 flag 返回不同 label |
| `web/src/components/terminal-socket-setup.ts` | `TerminalSocketHandlers` 加 `onFirstData`；wire 到 `TerminalSocket` |
| `web/src/components/terminal.tsx` | `Props` 加 `onFirstData`；handlersRef 自动转发（getHandlers pattern） |
| `web/src/pages/workspace.tsx` | 加 `awaitingFirstData` state + `onWsFirstData` callback；id 切换 reset；onConnected 不 reset awaiting（已在 id reset 中）；wsConnLabel 调用传 awaiting；TerminalView 传 onFirstData |
| `web/src/ws.test.ts` | 加 onFirstData first snapshot / first output / 不重复触发的 case |
| `web/src/ws-conn-label.test.ts` | 加 connected + awaitingData=true 返回新 label 的 case |

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 首字节后不回退 awaiting | `firstDataDelivered` latch 单调 false → true，reconnect 不 reset；workspace `awaitingFirstData` 也只通过 id 切换 reset，onConnected 不 reset |
| awaiting 仅在 connected 时生效 | wsConnLabel 仅 `c === 'connected'` 分支看 awaitingData；其他 conn state 字面不变 |
| 老 caller 不破 | wsConnLabel awaitingData 参数 optional，默认 undefined → falsy |
| snapshot/output 任一即满足 | dispatch 两个分支都 fire onFirstData latch；其他 frame 不动 latch |
| 切换 session 重新进入 awaiting | TerminalView key={id} 重建 TerminalSocket → 新实例 latch=false；workspace useEffect[id] reset awaitingFirstData=true |

## 不做

- WsConnection 增第 5 态 `'awaiting-data'`（D1 否）
- snapshot 之外的其他 frame 也算"数据"（D2 否）
- 反向显式 "PTY 数据已停" 提示（cc 正常 idle 时 PTY 静默，不能从无数据
  推断异常；现有 status='dead' 路径已覆盖真异常）
- 加超时告警（"等待 30s 还没数据 → 提示用户" 类）——属于独立超时 UX 课题，
  本次只解决 "已连接" 字面误导
- 中间态有动画 spinner（label 文本足够，加 spinner 是独立视觉课题）
