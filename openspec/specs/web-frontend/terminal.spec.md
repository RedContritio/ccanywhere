# Web Frontend — Terminal

终端视图 / renderer / dims state machine / placeholder / 软键盘 overlay /
文本选择与触摸滚动 / 客户端诊断收集 / 移动端虚拟工具栏 8 个 Requirement。
其它 web frontend Requirement（前端入口 / 配对登录 / Idempotency-Key /
session 列表 / 主题 / 路由 / 桌面通知 / 后台轮询）见 [spec.md](./spec.md)。

## Requirements

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
session `state == 'dead'` 后 MUST 停止重连并提示用户。

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
- THEN  client onclose 看 code === 1008，进入终态 `reason='session-gone'`
- AND   `scheduleReconnect` MUST NOT 被调用
- AND   UI ws-conn-chip 显示"会话不存在"

#### Scenario: 远端 DELETE 触发 4002 终态

- GIVEN device A 在 session `S` ws active；device B 调 `DELETE /api/sessions/S`
- WHEN  server 端 markDeleted → kill → cc exit → teardown 路径选 close code
        4002（详见 `openspec/specs/ws-protocol/spec.md` "Close code 表"）
- THEN  device A 的 ws 收到 close 4002
- AND   client 进入终态 `reason='session-deleted'`，UI 显示"已被删除"
- AND   `scheduleReconnect` MUST NOT 被调用

### Requirement: 终端 renderer 选择策略

xterm.js 提供 dom / canvas / webgl 三种渲染器。前端 MUST 默认用 webgl
渲染器：

- canvas addon (`@xterm/addon-canvas`) 上游已 deprecate；高 DPR 下 atlas
  内部 race 不再修，dogfood 实测出现整页错位。
- dom 渲染器在 cc TUI 全屏重画的密 frame 下做 ~1500 DOM mutations / paint
  （`replaceChildren()` 一次性替换所有可见行），mobile 主线程 stall
  30-80ms / 帧，60fps 不可达。
- webgl 渲染器在 `term.dispose()` 调用顺序梳理后不再触发
  `_isDisposed` undef race（AddonManager 内部链式 dispose addon，外部
  MUST NOT 手动 dispose 单独 addon——重复 dispose 是历史 race 的根因）。

URL `?renderer=dom|canvas|webgl` query 参数 MAY 覆盖默认选择，但本次覆盖
MUST NOT 持久化到 localStorage——刷新或新开标签后回到 webgl 默认。理由：
不能让一次"试一下 dom"留下 localStorage 残留导致后续访问继续走慢路径。

session 切换或销毁时 MUST `term.dispose()` 但 MUST NOT 手动 dispose 单独的
addon。`term.dispose()` 调用 MUST 包 try/catch，失败时记 ops-log 但不让
异常向上传播。

#### Scenario: 默认 renderer 是 webgl

- GIVEN 全新浏览器、URL 不带 `?renderer`
- WHEN  打开 workspace
- THEN  实际渲染器 kind 为 `webgl`

#### Scenario: ?renderer=dom 不写 localStorage

- GIVEN URL `?renderer=dom`
- WHEN  打开 workspace 然后关闭页面、重开(无 query)
- THEN  实际渲染器 kind 仍是 `webgl`（不被上一次会话污染）

### Requirement: 客户端尺寸生命周期（dims state machine）

终端容器的 cols/rows 测量值在 mount 后并非立即可信——mobile layout
经常在 mount 时仍处于 transition（drawer 收缩、Safari toolbar 收起、
软键盘弹起 / 收起、orientation 变化）。前端 MUST 用显式状态机把"测量
何时算 stable"建模出来，而不是同步信任 mount 时的 `container.clientHeight`。

状态机 MUST 有以下三态 + 一个 terminal 态：

```
unmeasured           ResizeObserver 还未 callback
awaiting-quiescence  至少有一次测量；正在等"静默"判定 layout 已稳
stable               尺寸已稳定；IO 解锁
terminated           组件已 unmount，所有副作用已 tear down
```

转换规则：

| 当前 | 事件 | 下一状态 | 副作用 |
|---|---|---|---|
| `unmeasured` | ResizeObserver callback `(c,r)` | `awaiting-quiescence(c,r)` | arm timer at +`QUIESCENCE_MS` |
| `awaiting-quiescence` | ResizeObserver callback `(c',r')` | `awaiting-quiescence(c',r')` | clear & re-arm timer |
| `awaiting-quiescence(c,r)` | timer fires | `stable(c,r)` | 创建 Terminal、`term.open`、`fit.fit()`、`sock.send({type:'resize',cols:c,rows:r})`、flush 任何 pending WS frames |
| `stable(_,_)` | ResizeObserver callback `(c',r')` | `stable(c',r')` | `fit.fit()` + `sock.send({type:'resize',cols:c',rows:r'})` |
| any | unmount | `terminated` | clearTimeout, term.dispose, sock.close |

不变量 MUST 保持：

- `awaiting-quiescence` 状态下 Terminal 实例 MUST NOT 存在。所有 xterm IO
  仅在 `stable` 之后。
- `awaiting-quiescence` 至多有一个 timer 在运行；新 callback 一定先
  clearTimeout 再 arm。
- 进入 `stable` 是单一入口（timer fires），单次创建 xterm；后续
  `stable` → `stable` 不重新创建。

`QUIESCENCE_MS` MUST 由"layout transition 上限 × 安全余量"推导，不直接
拍数字。基线：`LAYOUT_TRANSITION_UPPER_BOUND_MS=250` (Material Design
`large` motion 上限附近、iOS toolbar / Android 软键盘 transition 时长
中位数偏上)、`SAFETY=1.2` (吸收 ~一帧抖动)，对应 `QUIESCENCE_MS = ⌈250 × 1.2⌉ = 300`。

`MAX_WAIT_MS = QUIESCENCE_MS × 5 = 1500`：从 mount 起最多等 5 个 quiescence
窗口，仍 `unmeasured` 时强制走 fallback 路径（`container.clientWidth/Height`
+ `fit.proposeDimensions()` 直接量出）并直接进 `stable`。该值与 server 端
WS initial-state `1.5s` 兜底对齐——客户端 stable 永远先于 server 兜底到达。

WebSocket connection MUST 与 dims state machine 解耦——可在
`unmeasured` 时即建立连接。`onConnected` MUST NOT 主动 fit + send
resize；send resize 的责任完全在 dims 状态机的 transitionToStable +
stable→stable 路径。Server 端"等首个 resize 才发 initial state"
（`openspec/specs/ws-protocol/spec.md`）兜住竞速。

#### Scenario: mount 后 layout transition 中多次 callback 仅产生一次 mount

- GIVEN mobile 浏览器加载 workspace；layout 在 mount 后 100ms 内有 3 次
  ResizeObserver callback（drawer 收缩 / Safari toolbar 收起）
- WHEN  最后一次 callback 后 layout 稳定，无更多 callback
- THEN  300ms 后 (一次 QUIESCENCE_MS 静默) 状态机进 `stable`
- AND   Terminal 在那一刻才被创建并 `term.open` 到 container
- AND   server 收到的 first resize 帧 cols/rows 即 stable 测量值

#### Scenario: stable 之后 layout 变化即时响应

- GIVEN 状态机已进 `stable`
- WHEN  用户旋转屏幕 / drawer 切换，触发 ResizeObserver callback
- THEN  状态机仍为 `stable`，但 fit + send resize 立即执行（无 quiescence
  等待）
- AND   cc 收到对应 SIGWINCH 后重画到新 dims

#### Scenario: ResizeObserver 永不 fire 时兜底

- GIVEN mount 后 1500ms 内 ResizeObserver 一次都没 callback (iOS Safari
  极端场景)
- WHEN  mount 后 `MAX_WAIT_MS = 1500` 触发
- THEN  状态机走 fallback 路径：用 `container.clientWidth/Height` +
  `fit.proposeDimensions()` 直接量出 dims
- AND   `recordOp('dims.fallback')` 落 ops-log
- AND   状态机直接进 `stable` 与正常路径行为一致

### Requirement: 终端 mount 期间显示 placeholder

`unmeasured` / `awaiting-quiescence` 状态下，container 内 MUST 显示
placeholder 而非空白，避免用户误以为页面卡死。Placeholder MUST：

- 视觉上接近最终 xterm（深色 / 浅色按 effective theme，背景色一致）
- 含一个轻量 loading 指示（细线 cursor 闪烁或 spinner）
- 文案"加载中…"或同义短句，非主视觉
- 不接受用户键入（不会触发软键盘弹起）

进入 `stable` 后 Terminal `term.open` 到同一 container，placeholder
被替换。

#### Scenario: mount 后短暂显示 placeholder

- GIVEN 进入 workspace
- WHEN  ≤ ~300 ms (典型 quiescence + xterm 创建)
- THEN  容器先显 placeholder，随后被真实 xterm 替换
- AND   总切换时间感 < 500 ms（无明显阻塞）

### Requirement: 软键盘 cc 必须收到 resize（m-keyboard-resize）

软键盘弹起 / 收起 MUST 触发 cc SIGWINCH（fit.fit() + send `resize`），让
cc 收到收缩后的 `rows`，绘制限制在可见区域内。

旧方案 `transform: translateY(-keyboardH)` 已弃：视觉抬升但 cc 不知 rows
被遮，持续向键盘盖住的物理行写输出 → 新输出落键盘后看不见 + scrollback
被推一行出去（dogfood `0d84f615` 实证；归档 `2026-05-11-m-keyboard-resize`）。

实现 MUST：

- workspace / terminal 容器用 `100svh`（small viewport height）锚 layout，
  使 URL bar 显示状态切换不改 layout viewport
  - 不用 `100lvh` / `100dvh`（前者超 visible，后者与 vv 路径双重 fire）
- viewport meta MUST NOT 含 `interactive-widget=resizes-content`——保持
  默认 `resizes-visual`
- 监听 `window.visualViewport.resize` + `scroll`：
  ```
  keyboardH = max(0, document.documentElement.clientHeight
                     - visualViewport.height
                     - visualViewport.offsetTop)
  ```
  公式覆盖 iOS Safari (`offsetTop > 0`) + Android Chrome (`offsetTop = 0`)
- **`.terminal-pane-content` 应用 `padding-bottom: ${keyboardH}px`**——
  flex content area 物理收缩 → `.terminal-host` (`flex: 1`) 实高变小 →
  注册在 host 上的 ResizeObserver fire → dims state machine
  `resizedWhileStable` 分支 → fit.fit() + send `resize` 帧
  - **不用 transform: translateY**：cc rows 信号路径会断
  - **不改 layout viewport 全局高度**：与 dims state machine 冲突
- `.terminal-pane-content` 仅含 `[terminal-host + MobileToolbar]`，
  padding 推 toolbar 上移；`.terminal-header` 在 `.terminal-pane-content`
  **外**不受 padding 影响，保留原位置
- `.workspace-header` 应用 `transform: translateY(${vv.pageTop}px)` 反向
  counter 浏览器对焦点 input 的 auto-scroll（独立通道）
- `.terminal-header position: relative; z-index: 5` 保留——workspace-header
  的 transform 仍创建 stacking context
- VisualViewport API 不可用（iOS 12 / 老 WebView）降级：保持 layout 不
  调整 + 记 `recordOp('kbd.fallback')`

#### Scenario: 键盘弹起 cc 收 resize

- GIVEN xterm 已 stable，rows = 60
- WHEN  软键盘弹起，`visualViewport.resize` 触发，keyboardH ≈ 23 行高
- THEN  `.terminal-pane-content padding-bottom = ${keyboardH}px`
- AND   `.terminal-host` 物理收缩 → ResizeObserver fire
- AND   dims state machine 进 `resizedWhileStable` → `fit.fit()` 调用
- AND   `sock.send({ type: 'resize', cols, rows: ~37 })` 发出
- AND   cc 新输出落可见区域；`.terminal-header` 位置不变

#### Scenario: 键盘收起恢复

- GIVEN 键盘已弹起，padding-bottom > 0，rows ≈ 37
- WHEN  键盘收起，`visualViewport.height` 恢复满高
- THEN  `.terminal-pane-content padding-bottom = 0`
- AND   `.terminal-host` 恢复满高 → ResizeObserver fire → 新 `resize`
  帧 rows 恢复 60

#### Scenario: header 在键盘弹起时不动

- GIVEN 移动端 workspace，键盘已弹起
- WHEN  观察 `.terminal-header` 屏幕位置
- THEN  与弹起前一致；汉堡菜单按钮在原位可点击

### Requirement: 终端文本选择与触摸滚动接管

xterm 5 内部在 `Terminal.ts:835` 自挂 `touchmove` listener，触发
`Viewport.handleTouchMove` 以 `_viewportElement.scrollTop += deltaY`
方式滚动并按 `round` 量化到 1 行/帧（"翻一行" bug）。前端 MUST 在 xterm
container 上以 capture-phase 注册 `touchstart` / `touchmove` listener
并对每个事件调 `stopImmediatePropagation()`，完全切断 xterm 内部触摸
路径，自行实现触摸滚动与长按选择。

触摸状态机 MUST 是三态互斥：

```
idle       touchstart 后未决；待 long-press timer 或位移触发分支
scroll     位移超过 TAP_THRESHOLD_PX 在 LONG_PRESS_MS 之前 → 进 scroll
selection  long-press timer 触发且仍 idle → 进 selection
```

常量 MUST 由 OS / 业界基线推导，不拍数字：

- `LONG_PRESS_MS = 500`：Android `ViewConfiguration.getLongPress
  Timeout()` 默认 500ms；iOS `UILongPressGestureRecognizer.minimum
  PressDuration` 默认 0.5s。对齐 OS muscle memory。
- `TAP_THRESHOLD_PX = 6`：Android tap slop 8 dp / Material 8 dp /
  Hammer.js 10 px 偏紧；下限 ~5 px 是手指自然抖动。选 6 偏 scroll-first
  让滚动更敏感，长按仍能在静止手指下触发。
- `VISUAL_LINE_HEIGHT_FACTOR = 1.2`：monospace TUI 业界 line-height
  默认；让 `cellHeight = fontSize × 1.2`，与 xterm 内部 cell pitch 解耦
  （内部 pitch ~9.29 px 对触摸滚动过敏）。
- `TOUCH_STALL_THRESHOLD_MS = 30`：连续 touchmove 间隔超过该值视为
  手指停顿，重置 self-driven scroll 累积器，避免 stall 后单帧大跳。

scroll 路径：

- 容器 capture-phase `touchmove` 累计 `dyAccum += event.touches[0].clientY
  - lastTouchY`，`lastTouchY` 更新。
- 每帧调 `lines = trunc(dyAccum / cellHeight)`；`lines !== 0` 时调
  `term.scrollLines(-lines)` 并消耗 `dyAccum -= lines × cellHeight`。
- `cellHeight = (term.options.fontSize ?? FONT_SIZE_DEFAULT) ×
  VISUAL_LINE_HEIGHT_FACTOR`；fontSize 在 mount 时定，theme 切换或
  resize 不会改其值。

selection 路径：

- 长按 timer fire 且 `touchMode === 'idle'` 时 → `touchMode = 'selection'`，
  立即 `dispatchMouseEvent('mousedown', x, y)` 让 xterm selection service
  接管。
- 后续 `touchmove` 派生 `mousemove`；`touchend` 派生 `mouseup`。
- `touchend` 后 `setTimeout(0)` 让 xterm 完成 selection 计算，再调
  `term.getSelection()`，非空时 `navigator.clipboard.writeText(text)`。
  - 失败种类记 ops：`term.selection.copy.{ok,fail,empty,unavailable}`。
  - `unavailable`：`navigator.clipboard` 在非 https 或不被 user-gesture
    覆盖时缺失，不抛错。

ops 埋点 MUST 包含：`touch.start` / `touch.end` / `touch.drag.start` /
`touch.drag.move`（throttled）/ `touch.longpress` / `term.selection.copy.*`。

#### Scenario: 单指上下拖动按拖距比例滚动

- GIVEN 移动端 xterm 已 stable，cc 在 alt-screen
- WHEN  用户单指上拖 90 px (cellHeight 约 18 → 5 行)
- THEN  `term.scrollLines(-5)` 被调用
- AND   `dyAccum` 余数 ≤ cellHeight 留待下帧
- AND   xterm 内部 `Viewport.handleTouchMove` MUST NOT 被调用
  （capture-phase `stopImmediatePropagation` 切断）

#### Scenario: 长按 500ms 进 selection 模式并复制

- GIVEN xterm 已 stable，光标稳定
- WHEN  用户单指按住屏幕 ≥ 500ms 不动 (移动 < 6 px)
- THEN  `touchMode` 变 `selection`
- AND   xterm selection service 被 mousedown 事件触发，开始选中
- AND   touchend 后非空选中文本被 `navigator.clipboard.writeText` 写入
- AND   `recordOp('term.selection.copy.ok')` 落 ops

#### Scenario: 长按前已位移则进 scroll，不进 selection

- GIVEN 用户 touchstart 后 200ms 内位移 12 px (> TAP_THRESHOLD_PX)
- WHEN  500ms long-press timer fire
- THEN  此时 `touchMode` 已是 `scroll`（不再 idle），timer 回调发现
  状态非 idle 不触发 selection
- AND   滚动路径正常进行

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
  `sessionIds`（zustand store 全列）、`theme`（`useUiStore` 当前 mode）、
  `effectiveTheme`（`effectiveTheme(mode)` 返回）。
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
`setActiveTerm({term, ws, sessionId, rendererKind, lastWriteTs})`、
unmount 时 `setActiveTerm(null)`。非 workspace 页（登录/配对）的反馈 diag
中 `term` / `ws` 缺失，其它字段（viewport / net / memory）仍收集。

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

### Requirement: 移动端虚拟工具栏

当 viewport 满足 `pointer: coarse OR max-width: 768px` 时，前端 MUST 在
终端下方显示固定虚拟工具栏，至少包含按键：

- `Esc` → 发 `\x1b`
- `Tab` → 发 `\t`
- `Ctrl`（粘性 modifier）
- 方向键 `↑ ↓ ← →` → 发对应 ANSI escape

`Ctrl` 粘性：点击后视觉高亮 + 进入"等待下一键"状态；下一次按键（无论是工具栏
按钮还是软键盘字符）发送 `Ctrl+<key>` 即字节 `key.charCodeAt(0) & 0x1f`，然后
退出 Ctrl 状态。

工具栏 MUST 不抢焦点（不让软键盘消失）。

#### Scenario: Ctrl + C 发 0x03

- GIVEN 移动端工具栏可见
- WHEN  用户点 `Ctrl`，然后通过软键盘输入 `c`
- THEN  WebSocket 收到 `{ type: "input", data: "\x03" }`
- AND   `Ctrl` 按钮高亮在 `c` 输入后清除
