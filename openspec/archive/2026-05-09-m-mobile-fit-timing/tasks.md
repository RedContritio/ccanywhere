# Tasks: M-mobile-fit-timing

## 状态机抽离

- [ ] T1. 新文件 `web/src/components/dims-state.ts`：导出 `DimsState`
  类型 + `dimsReducer(state, event)` 纯函数（接受 `{kind:'callback',cols,rows}` /
  `{kind:'timer-fired'}` / `{kind:'unmount'}`，返回新 state + 副作用清单
  `{startTimer?,clearTimer?,emitStable?}`）。这是一个 plain reducer，
  不持有 timer / IO，方便单元测试。
- [ ] T2. 单元测试 `dims-state.test.ts`：覆盖 design 表里所有转换 +
  unmeasured/awaiting-quiescence/stable 的 invariants。

## terminal.tsx 重构

- [ ] T3. mount useEffect 重写：
  - 不同步创建 Terminal、不调 fit、不 send resize。
  - 立即创建 TerminalSocket，挂 onSnapshot/onOutput 等 handler 但 buffer
    内不写——term 还不存在，记到 pendingFrames。
  - 在 placeholder container 上挂 ResizeObserver，每次 callback 通过
    `dimsReducer` 推进状态。
  - timer-fired 触发 `mountTerminalAndFlush(cols, rows)`：创建 Terminal、
    open 到 container（替换 placeholder）、加载 addons、`fit.fit()`、
    `sock.send({type:'resize',cols,rows})`、把 pendingFrames flush 进
    term、安装 input + touch + selection trace。
  - stable→stable callback 走轻量路径：`fit.fit()` + send resize（不再
    创建 term）。
- [ ] T4. cleanup 路径：clearTimeout、observer.disconnect、term?.dispose、
  sock.close、setActiveTerm(null)、解绑 touch/mouse listener。
- [ ] T5. Placeholder 视觉：黑色或主题色背景 + 中央 cursor 闪烁（≤ 10 LOC
  CSS），文字 "加载中…" 较小不抢戏。
- [ ] T6. WS 解耦：`onConnected` 不再 `fit + send resize`。仅记录连接成功，
  send resize 责任完全交给 dims state machine 的 transitionToStable +
  stable→stable callback。

## 兜底

- [ ] T7. ResizeObserver-never-fires 场景兜底：mount 后 `MAX_WAIT_MS = 1500`
  内若仍 `unmeasured`，强制用 `container.clientWidth/Height` +
  `fit.proposeDimensions()` 计算并直接 transitionToStable。recordOp
  `dims.fallback`。
- [ ] T8. recordOp 埋点：`dims.callback(c,r)` / `dims.stable(c,r)` /
  `dims.fallback`——让 trace 直接看到状态机轨迹。

## Visual viewport 通道（键盘）

- [ ] T_kbd1. CSS 迁移：`web/src/styles/app.css` 中所有 `100dvh` /
  `min-height: 100dvh` 按 design.md 表格逐项决策——terminal-host 与
  app shell 改 `100lvh`；登录页 / 反馈 dialog 等全屏 modal 保留 `dvh`。
- [ ] T_kbd2. 在 terminal.tsx mount useEffect 内挂 VisualViewport
  listener：`resize` + `scroll` 都调 `applyKeyboardOffset`，初次
  mount 时调一次。cleanup 时 removeEventListener + 清 transform。
- [ ] T_kbd3. `applyKeyboardOffset(container)`：`container.style.transform =
  \`translateY(${-window.visualViewport.offsetTop}px)\``。container 取
  terminal-host 外层（不是 xterm 内部，避免影响 xterm 自身坐标系）。
- [ ] T_kbd4. Fallback：`window.visualViewport === undefined` 时
  container 用 inline `style.minHeight = '100dvh'` 覆盖 CSS 的 lvh，
  让 ResizeObserver 仍然能在键盘弹起时触发，走原状态机路径。recordOp
  `dims.kbd.fallback` 落 ops。
- [ ] T_kbd5. recordOp 埋点：`kbd.shift(offsetTop)` —— 让 trace 能看到
  键盘事件与 dims state 互不重叠。

## Spec delta

- [ ] T9. `specs/web-frontend/spec.md` 加 Requirement"客户端尺寸生命周期"
  （unmeasured/awaiting-quiescence/stable 三态、ResizeObserver 唯一
  触发器、QUIESCENCE_MS 推导、MAX_WAIT_MS 兜底、与 ws-protocol 初始化
  序列的协作）+ Requirement"软键盘 visual viewport 跟随"（VisualViewport
  API 监听、translateY 跟随、不调 fit、不 send resize、CSS 100lvh、
  fallback 降级路径）。

## 测试

- [ ] T10. 集成测试（mock ResizeObserver + fake timer）：
  - 模拟 mount 后 100ms 内多次 callback（transition 中）→ 仅 timer 静默
    后触发一次 mount。
  - 模拟 stable 后 callback → 立即 fit/send。
  - 模拟 unmount 在 awaiting-quiescence 中 → cleanup 无异常。
  - 模拟 ResizeObserver 永不 fire → MAX_WAIT_MS 后 fallback path 触发。
- [ ] T11. e2e 手动复现：
  - mobile 浏览器 mount workspace，验证 7.5s 不再出现，初始 fit 直接
    在静默窗口后落到 75×23。
  - 键盘弹起，验证 cc SIGWINCH 在键盘 stable 后触发。
  - 旋转屏幕，验证状态机响应。
- [ ] T12. 后端 vitest / 前端 vitest / tsc --noEmit 全绿。

## 归档

- [ ] T13. 合并 `changes/m-mobile-fit-timing/specs/web-frontend/spec.md`
  到 `openspec/specs/web-frontend/spec.md`。
- [ ] T14. 移动 `changes/m-mobile-fit-timing/` 到
  `archive/<YYYY-MM-DD>-m-mobile-fit-timing/`。
- [ ] T15. commit。

## Commits

- (no matching commits found in git log)
