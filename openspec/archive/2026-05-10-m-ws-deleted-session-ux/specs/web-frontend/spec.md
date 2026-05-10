## MODIFIED Requirements

### Requirement: 终端视图

主界面 MUST 在右侧渲染一个 xterm.js 终端，绑定到当前选中的 session。组件
挂载时 MUST：

1. 通过 `/ws/sessions/:id` 建立 WebSocket（cookie 自动随 same-origin upgrade
   带；不带 `?token=`；重连时 MAY 带 `?lastSeq=N`，见"WebSocket 重连协议"）。
2. WebSocket open 之后 MUST 立即 `fit()` 并发首个 `{ type: "resize", cols, rows }`，
   让服务端协商初始状态时拿到对齐的尺寸（见
   `openspec/specs/ws-protocol/spec.md` "连接初始化序列"）。
3. 收到 `snapshot { upToSeq, data }` → `term.reset(); chunkedWrite(term, data)`。
4. 收到 `output { seq, data }` → `chunkedWrite(term, data)`，**不** reset
   buffer（incremental delta 路径）。
5. 收到 `status` 帧 → 更新顶部状态徽标。
6. 收到 `error` 帧 → 在终端最下方显示一条提示，连接保持。
7. 用户键盘输入 → 发 `{ type: "input", data }`。
8. `ResizeObserver` debounce 100ms 触发 `fit()` + 发 `{ type: "resize", cols, rows }`。

`chunkedWrite(term, data)` MUST 把超过约 4 KiB 的 write 分片到多个
`requestAnimationFrame` tick 喂给 `term.write`，避免大 snapshot 引起单帧阻塞。

addons MUST 包含 fit、unicode11（中文/emoji 宽度）、web-links（URL 可点）。

WebSocket 断开时 MUST 自动重连，指数退避：250ms → 500ms → 1s → 2s → 4s →
8s 然后保持 8s 间隔。`window` 的 `online` 事件与 `document.visibilitychange`
变为 `visible` MUST 立即触发 force reconnect（跳过当前退避窗口）。

### close code 终态契约

客户端 MUST 按 ws close code 决定是 reconnect 还是终态（详见
`openspec/specs/ws-protocol/spec.md` "Close code 表"）：

- `1008` → 终态 `reason='session-gone'`：server 端找不到该 sessionId
  （GC 后、server 重启后、从未存在）。MUST 停止 reconnect 退避，UI 显示
  "会话不存在"或同义文案。
- `4002` → 终态 `reason='session-deleted'`：该 session 已被 DELETE。
  MUST 停止重连，UI 显示"已被删除"。
- `4001` → 终态 `reason='session-expired'`（cookie 过期；预留给 #40 device
  expiry，本 task 不实施）。
- `1000` → 已经通过 `status='dead'` 帧路径进入终态 `reason='cc-exit'`，
  1000 close 是 follow-up，client `this.dead` 已 true，1000 close handler
  无需重复触发 `onDead`。
- 其它 code（`1006`, `1009`, `1011`, ...）→ MUST 触发 `scheduleReconnect`
  走指数退避（保持现行行为）。

`onDead(reason: DeadReason)` callback 接收终态原因，让 UI 区分文案：

| reason | UI 文案 |
|---|---|
| `cc-exit` | "会话已结束" |
| `session-gone` | "会话不存在" |
| `session-deleted` | "已被删除" |
| `session-expired` | (#40 实施) |

session `state == 'dead'` 后 MUST 停止重连并提示用户（保持现行；与
close code 终态语义合并）。

#### Scenario: 重连后视图通过 incremental 恢复

- GIVEN 用户在终端中执行命令 producing 多行输出，客户端记得 `lastSeq = L > 0`
- WHEN  网络短暂断开后恢复，WebSocket 用 `?lastSeq=L` 重连
- AND   服务端 `scrollback.tailSeq < L`
- THEN  客户端只收到 `output` 帧并 append（**不** 触发 `term.reset`）
- AND   终端视觉上无重影、无重写，content 与断开前一致

#### Scenario: server 重启后 stale tab 不死循环重连

- GIVEN client 在 session `S` 的 ws active
- WHEN  server 重启（in-memory `manager.sessions` 被清空），client 自动
        重连 → server 在 ws upgrade 时 `manager.get(S) === undefined`，
        发 `error` 帧 + close `1008`
- THEN  client onclose handler 看 code === 1008，进入终态 `reason='session-gone'`
- AND   `scheduleReconnect` MUST NOT 被调用
- AND   UI ws-conn-chip 显示"会话不存在"

#### Scenario: 远端 DELETE 触发 4002 终态

- GIVEN device A 在 session `S` ws active；device B 调 `DELETE /api/sessions/S`
- WHEN  server 端 markDeleted → kill → cc exit → teardown 路径选 close code
        4002
- THEN  device A 的 ws 收到 close 4002
- AND   client 进入终态 `reason='session-deleted'`，UI 显示"已被删除"
- AND   `scheduleReconnect` MUST NOT 被调用

#### Scenario: 1006 抖动仍重连

- GIVEN client 的 ws 因网络抖动收 close `1006`
- WHEN  client onclose 看 code === 1006（不在终态码表内）
- THEN  client MUST 触发 scheduleReconnect 走指数退避
- AND   `onDead` MUST NOT 被调用
