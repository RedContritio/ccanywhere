## ADDED Requirements

### Requirement: 客户端尺寸生命周期（dims state machine）

终端容器的 cols/rows 测量值在 mount 后并非立即可信——mobile layout
经常在 mount 时仍处于 transition（drawer 收缩、Safari toolbar 收起、
软键盘弹起 / 收起、orientation 变化）。前端 MUST 用显式状态机把"测量
何时算 stable"建模出来，而不是同步信任 mount 时的 `container.clientHeight`。

状态机 MUST 有以下三态：

```
unmeasured           ResizeObserver 还未 callback
awaiting-quiescence  至少有一次测量；正在等"静默"判定 layout 已稳
stable               尺寸已稳定；IO 解锁
```

转换规则：

| 当前 | 事件 | 下一状态 | 副作用 |
|---|---|---|---|
| `unmeasured` | ResizeObserver callback `(c,r)` | `awaiting-quiescence(c,r)` | arm timer at +`QUIESCENCE_MS` |
| `awaiting-quiescence` | ResizeObserver callback `(c',r')` | `awaiting-quiescence(c',r')` | clear & re-arm timer |
| `awaiting-quiescence(c,r)` | timer fires | `stable(c,r)` | 创建 Terminal、`term.open`、`fit.fit()`、`sock.send({type:'resize',cols:c,rows:r})`、flush 任何 pending WS frames |
| `stable(_,_)` | ResizeObserver callback `(c',r')` | `stable(c',r')` | `fit.fit()` + `sock.send({type:'resize',cols:c',rows:r'})` |
| any | unmount | terminated | clearTimeout, term.dispose, sock.close |

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
- WHEN  用户旋转屏幕 / 键盘弹起 / drawer 切换，触发 ResizeObserver callback
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

### Requirement: 软键盘 visual viewport 跟随

软键盘弹起 / 收起 MUST NOT 触发 cc SIGWINCH（即不调用 `fit.fit()`、不
send `resize` 帧）。键盘事件是 visual viewport overlay 而非 layout
viewport 变化，处理通道与 `客户端尺寸生命周期` 状态机正交。

实现 MUST：

- terminal-host 容器及其祖先用 `100lvh`（large viewport height）锚定
  layout，使键盘弹起时容器尺寸不变、ResizeObserver 不 fire。
- 监听 `window.visualViewport.resize` 与 `window.visualViewport.scroll`，
  将容器 `transform: translateY(${-visualViewport.offsetTop}px)` 让
  xterm DOM 整体上移，使 xterm 底边对齐 visual viewport 底边——cursor
  行始终可见。
- VisualViewport API 不可用时（iOS 12 / 老 WebView）降级：容器恢复
  `100dvh`，键盘事件走 layout 通道，按 `客户端尺寸生命周期` 状态机处理
  （此时回声延迟 ~500ms）。

#### Scenario: 键盘弹起 cc 不重画

- GIVEN xterm 已 stable，cc 处于 idle 等待输入
- WHEN  软键盘弹起
- THEN  visualViewport.resize 触发；container `transform: translateY(...)`
  即时生效
- AND   `fit.fit()` MUST NOT 被调用
- AND   `resize` 帧 MUST NOT 被发送给服务端
- AND   cursor 行在 visual viewport 底边之上仍然可见

#### Scenario: 键盘收起恢复

- GIVEN 键盘已弹起，container 已上移
- WHEN  键盘收起，visualViewport.offsetTop 归 0
- THEN  container `transform` 回归 `translateY(0)`
- AND   `fit.fit()` MUST NOT 被调用，`resize` 帧 MUST NOT 被发送

#### Scenario: VisualViewport API 不可用降级

- GIVEN 浏览器无 `window.visualViewport`
- WHEN  组件 mount
- THEN  container 用 `100dvh` 而非 `100lvh`
- AND   键盘弹起触发 ResizeObserver callback，按 `客户端尺寸生命周期`
  状态机处理（fit + send resize）

### Requirement: 终端 mount 期间显示 placeholder

`unmeasured` / `awaiting-quiescence` 状态下，container 内 MUST 显示
placeholder 而非空白，避免用户误以为页面卡死。Placeholder MUST：

- 视觉上接近最终 xterm（深色/浅色按 effective theme，背景色一致）
- 含一个轻量 loading 指示（细线 cursor 闪烁或 spinner）
- 文案"加载中…"或同义短句，非主视觉
- 不接受用户键入（键盘不会被它触发软键盘弹起）

进入 `stable` 后 Terminal `term.open` 到同一 container，placeholder
被替换。

#### Scenario: mount 后短暂显示 placeholder

- GIVEN 进入 workspace
- WHEN  ≤ ~300 ms (典型 quiescence + xterm 创建)
- THEN  容器先显 placeholder，随后被真实 xterm 替换
- AND   总切换时间感 < 500 ms（无明显阻塞）
