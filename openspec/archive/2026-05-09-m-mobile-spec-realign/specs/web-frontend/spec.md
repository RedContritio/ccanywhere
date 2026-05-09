## MODIFIED Requirements

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
- WHEN  打开 workspace 然后关闭页面、重开（无 query）
- THEN  实际渲染器 kind 仍是 `webgl`（不被上一次会话污染）

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

## ADDED Requirements

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

### Requirement: 软键盘视觉上移

软键盘弹起 / 收起 MUST NOT 触发 cc SIGWINCH（即不调用 `fit.fit()`、不
send `resize` 帧）。键盘事件是 visual viewport overlay 而非 layout
viewport 变化，处理通道与 `客户端尺寸生命周期` 状态机正交。

实现 MUST：

- workspace 容器及 terminal 容器 MUST 用 `100svh`（small viewport height）
  锚定 layout，使 URL bar / 键盘弹起 / 收起均不改变 layout viewport，
  ResizeObserver 不在键盘事件下 fire。
  - 不用 `100lvh`：URL bar 显示状态下超出 visible viewport，底部按钮
    被遮挡。
  - 不用 `100dvh`：URL bar / 键盘事件都触发 layout 变化，cc 被迫 SIGWINCH。
- viewport meta MUST NOT 含 `interactive-widget=resizes-content` ——保持
  浏览器默认 `resizes-visual`（layout viewport 不缩、visual viewport 缩）。
  meta 形如 `width=device-width, initial-scale=1.0, viewport-fit=cover`。
- 监听 `window.visualViewport.resize` 与 `window.visualViewport.scroll`：
  ```
  keyboardH = max(0, document.documentElement.clientHeight
                     - visualViewport.height
                     - visualViewport.offsetTop)
  ```
  公式 iOS Safari (`offsetTop > 0`，visual viewport 整体下移) 与 Android
  Chrome `resizes-visual` (`offsetTop = 0`，`height` 缩)两侧通用。
- `transform: translateY(${-keyboardH}px)` 应用在 `.terminal-pane-content`
  上（不是 `.terminal-pane`）—— `.terminal-pane-content` 仅包含
  `[terminal-host + MobileToolbar]`，让 `.terminal-header` 留在原 layout
  位置，header 在键盘弹起时不跟随上移。
- `.terminal-header` 与 `.workspace-header` MUST 显式 `position: relative;
  z-index: 5` —— `transform` 在 `.terminal-pane-content` 上隐式建
  stacking context，否则该子树视觉上覆盖 `.terminal-header`，header
  在 mobile top 区域被遮（dogfood 反馈"top bar 不停住"实证）。
- VisualViewport API 不可用时（iOS 12 / 老 WebView）降级：保持 layout
  不上移，键盘可能遮挡 cursor 行，记 `recordOp('kbd.fallback')`，不阻塞
  其它路径。

#### Scenario: 键盘弹起 cc 不重画

- GIVEN xterm 已 stable，cc 处于 idle 等待输入
- WHEN  软键盘弹起，`visualViewport.resize` 触发
- THEN  `.terminal-pane-content` `transform: translateY(-keyboardH)` 即时生效
- AND   `.terminal-header` 留在原 layout 位置，未被 translate
- AND   `fit.fit()` MUST NOT 被调用
- AND   `resize` 帧 MUST NOT 被发送给服务端

#### Scenario: 键盘收起恢复

- GIVEN 键盘已弹起，`.terminal-pane-content` 已上移
- WHEN  键盘收起，`visualViewport.height` 恢复满高
- THEN  `.terminal-pane-content` `transform` 回归 `translateY(0)`
- AND   `fit.fit()` MUST NOT 被调用，`resize` 帧 MUST NOT 被发送

#### Scenario: header 在键盘弹起时不动

- GIVEN 移动端 workspace，键盘已弹起
- WHEN  观察 `.terminal-header` 在屏幕上的位置
- THEN  其 top 与键盘弹起前一致（未被 transform 覆盖、未被遮）
- AND   汉堡菜单按钮在原位可点击

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
