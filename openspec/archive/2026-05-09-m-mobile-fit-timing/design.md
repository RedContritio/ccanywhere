# Design: M-mobile-fit-timing

## 状态机

```ts
type DimsState =
  | { kind: 'unmeasured' }
  | { kind: 'awaiting-quiescence'; cols: number; rows: number; timer: number }
  | { kind: 'stable'; cols: number; rows: number };
```

转换规则：

| 当前 | 事件 | 下一状态 | 副作用 |
|---|---|---|---|
| `unmeasured` | ResizeObserver callback `(c,r)` | `awaiting-quiescence(c,r,T)` | arm `T = setTimeout(quiescence, QUIESCENCE_MS)` |
| `awaiting-quiescence(_,_,T)` | ResizeObserver callback `(c',r')` | `awaiting-quiescence(c',r',T')` | `clearTimeout(T)`; arm `T'` |
| `awaiting-quiescence(c,r,T)` | timer fires | `stable(c,r)` | mount xterm into container; `fit()`; `sock.send({type:'resize',cols:c,rows:r})` |
| `stable(_,_)` | ResizeObserver callback `(c',r')` | `stable(c',r')` | `fit()`; `sock.send({type:'resize',cols:c',rows:r'})` |
| any | unmount | terminal disposal | `clearTimeout`; `term.dispose()`; `setActiveTerm(null)` |

不变量：

- `awaiting-quiescence` 状态下**永远没有** xterm 实例存在（即 `term`
  ref 为 null）。所有 xterm IO 都在 `stable` 之后。
- `awaiting-quiescence` 永远有且仅有一个 timer 在运行；新 callback 一定
  先 clearTimeout 再 arm。
- 进入 `stable` 是单一入口（timer fires），单次创建 xterm。`stable` →
  `stable` 不重新创建 xterm。

## QUIESCENCE_MS 推导

不拍数字，按推导：

```ts
const LAYOUT_TRANSITION_UPPER_BOUND_MS = 250;
const SAFETY = 1.2;
export const QUIESCENCE_MS = Math.ceil(LAYOUT_TRANSITION_UPPER_BOUND_MS * SAFETY); // 300
```

输入来源：

- **LAYOUT_TRANSITION_UPPER_BOUND_MS = 250**
  - Material Design `large` 容器 motion 上限 300ms（取最大）
  - iOS Safari toolbar 收起测得 ~200ms
  - Android Chrome 软键盘弹起 typically ~200-250ms
  - CSS Animations 推荐 transition ≤ 300ms 不致用户感知卡顿
  - 取 250 是中位数偏上

- **SAFETY = 1.2**
  - 吸收一帧（@60Hz = 16ms）的抖动 + 稍有 buffer
  - 保留可解释性（SAFETY = "20% 余量" 是直觉量）

未来调整时只改输入常量，不直接调 300。

## 修改后 mount 流程

```ts
useEffect(() => {
  const container = containerRef.current!;
  let dims: DimsState = { kind: 'unmeasured' };
  let term: Terminal | null = null;
  let sock: TerminalSocket | null = null;

  // WebSocket 与尺寸状态机解耦——可在 unmeasured 时即建立连接，
  // server 'wait for first resize' 协议兜住竞速。
  sock = new TerminalSocket(props.sessionId, {
    onSnapshot: (data) => term?.reset(); chunkedWrite(term!, data, 'snapshot'),
    onOutput:   (data) => chunkedWrite(term!, data, 'output'),
    // ...
  });

  const transitionToStable = (cols: number, rows: number) => {
    dims = { kind: 'stable', cols, rows };
    // 一次性创建 xterm
    term = createTerminal();
    term.open(container);
    // 此时 container 已 stable，fit 一定算出 (cols, rows)，
    // 但仍走 fit() 让 xterm 内部 dims 与 DOM 对齐
    fit.fit();
    sock!.send({ type: 'resize', cols, rows });
    // ... 安装 input/touch handler / setActiveTerm 等
  };

  let quiescenceTimer: number | null = null;
  const observer = new ResizeObserver((entries) => {
    const measured = measureDims(container, entries);  // (cols, rows)
    if (dims.kind === 'unmeasured') {
      dims = { kind: 'awaiting-quiescence', ...measured, timer: 0 };
      quiescenceTimer = window.setTimeout(() => transitionToStable(...measured), QUIESCENCE_MS);
    } else if (dims.kind === 'awaiting-quiescence') {
      // 测量值变化或不变，都重置静默期
      window.clearTimeout(quiescenceTimer!);
      dims = { kind: 'awaiting-quiescence', ...measured, timer: 0 };
      quiescenceTimer = window.setTimeout(() => transitionToStable(...measured), QUIESCENCE_MS);
    } else {
      // stable: 直接 fit + send
      fit.fit();
      sock!.send({ type: 'resize', cols: measured.cols, rows: measured.rows });
    }
  });
  observer.observe(container);

  return () => {
    if (quiescenceTimer !== null) window.clearTimeout(quiescenceTimer);
    observer.disconnect();
    term?.dispose();
    sock?.close();
  };
}, [props.sessionId]);
```

注：`measureDims` 实现细节——可以从 `entries[0].contentBoxSize` 取，
或从 `term.cols/rows` 经 `fit.proposeDimensions()` 计算。前者无需创建 term，
更简洁。

## Placeholder UI

mount 到 `awaiting-quiescence` → `stable` 之间的窗口（≤ 300ms 静默 +
xterm 创建 ~50ms ≈ 350ms 平均），container 显示 placeholder：

```tsx
<div ref={containerRef} className="terminal-view">
  {dimsKind !== 'stable' && <div className="terminal-placeholder">…</div>}
</div>
```

placeholder 视觉上与最终 xterm 接近（深色/浅色背景按 effective theme，
中间一个细线 cursor 闪烁）以减少视觉跳变。

## 决策记录

### 决策 1（已反转）：软键盘走 visual viewport 通道，不走 layout 通道

**反转背景**：本提案早期把所有 layout 类事件（drawer / orientation /
Safari toolbar / 软键盘）放进同一个 ResizeObserver + 状态机路径，理由
是"单一规则覆盖所有来源"形式上更干净。代价是键盘弹起瞬间 ~500ms 回声
延迟（quiescence + cc SIGWINCH 重画）。

**反转触发**：实际上**软键盘不是 layout 事件**——浏览器规范层面，软键盘
是 visual viewport overlay，不改变 layout viewport。把它当 layout 事件
是 CSS 单位选择（`100dvh`）造成的语义错配，不是事件本质。把两类事件强
合并是简化，不是形式化。

**反转后建模**：

- **Layout viewport 事件**（drawer / orientation / Safari toolbar / dialog）
  → ResizeObserver 监听 `100lvh` 容器 → DimsStateMachine → fit + send resize。
- **Visual viewport overlay 事件**（软键盘弹/收）→ VisualViewport API
  监听 → DOM `translateY(offsetTop)` → **不** fit、**不** resize。cc 不
  感知键盘。

两通道由浏览器规范天然正交：ResizeObserver 不在 visual viewport 变化时
fire；VisualViewport.resize 不在 layout viewport 变化时 fire（只要 layout
viewport 锚定 100lvh 而非 100dvh）。

**收益**：

- cc 不重画 → "两份 banner" 类的 cc 渲染叠加风险与键盘解耦。
- 键盘弹起回声延迟从 ~500ms 降到 ~0ms（DOM translate 即时跟随 offsetTop）。
- 状态机更干净——layout 通道不必处理"keyboard 弹起也是 layout 抖动"这种
  伪 transition。

**代价**：

- xterm DOM 上沿超出 visual viewport 上沿一段（≈ 键盘高度），约一两行
  banner / 旧 chat 在键盘期间看不见。用户输入时关注 cursor 行附近，
  顶部历史不可见可接受。
- CSS 必须从 `100dvh` 改 `100lvh`。已用 `100dvh` 的地方需要识别哪些
  应保持随键盘缩（如登录页/反馈 dialog 全屏 modal——它们应当用 dvh，
  让自身随键盘缩）、哪些应该用 lvh（terminal-host 容器）。
- 需要 VisualViewport API（iOS 13+ / Chrome 61+）；不支持的浏览器降级到
  旧 dvh + resize 路径。

**形式化要点**：从"一个规则覆盖所有事件"细化为"两个规则各自精确覆盖一类
事件"，**仍是形式化**——并且建模与浏览器规范一致（layout vs visual
viewport 是 spec 层定义的正交概念），比一锅烩的方案更稳。

### 决策 2：WebSocket 与尺寸状态机解耦，mount 时即建立连接

**为何**：

- WS 建立耗时（DNS/TLS/握手 ~50-200ms）与状态机平行进行，省 ~一个 RTT
  的总延迟。
- server 端"等首个 resize 才发 initial state" 已实现——竞速不会让
  client 收到 stale snapshot。
- 与"WS 不可用 → terminal 不可用" 的退化语义一致；WS 失败时 placeholder
  展示 reconnect 状态，xterm 仍未创建，资源最少。

**风险**：WS connect 在 stable 之前就 onOpen → 内部 onConnected callback
试图 `fit.fit() + send resize`。需要让 onConnected 不主动 send resize，
仅触发记录"已连接"。send resize 的责任从 onConnected 移到状态机的
transitionToStable + stable→stable callback 路径。

### 决策 3：`stable` 之后不再走 quiescence

**为何**：layout 已经稳定过一次的前提下，后续 callback 都是真实的
layout 变化（drawer 收缩 / 旋转 / 键盘）——它们一定会再次触发新一轮
transition。但因为我们 stable→stable 已立即响应，不需要再等 300ms：
单次响应延迟比"等 300ms 才响应每次变化"更优。

如果出现 layout 抖动（连续 callback 但每次值不同），stable→stable 路径
会导致 cc SIGWINCH 风暴。但 ResizeObserver spec 保证 callback 仅在
内容变化时触发，连续抖动意味着 layout 真在动——这种场景已属 pathology，
不在 quiescence 的 mandate 内。

### 决策 4：placeholder 期间键入触发软键盘的语义

xterm 不存在时，placeholder 上没有 input 接受器——软键盘不会被键入触
发。但用户可能 tap placeholder 试图聚焦——此时无 visible cursor。
placeholder UI 应明确显示"加载中"，避免误以为 xterm 已 ready。

## 测试策略

- 单元测试 `dims-state.ts` 状态机：
  - mount → callback → awaiting-quiescence
  - awaiting-quiescence + callback (相同 dims) → reset timer
  - awaiting-quiescence + callback (不同 dims) → reset timer，新 dims
  - awaiting-quiescence + 静默 N ms → stable
  - stable + callback → stable + 立即 fit + send
- 集成（fake timer + mock ResizeObserver）：
  - 模拟 mount 时多次 callback (mobile transition 中) → 仅在静默后触发
    `transitionToStable` 一次
  - 模拟 stable 后键盘弹起 callback → 进 awaiting-quiescence → 静默后
    stable
  - 模拟 quiescence 期间 unmount → cleanup 不抛异常，timer 被清

## Visual viewport 通道实现

```ts
// Setup once on mount; survives across DimsStateMachine transitions.
const applyKeyboardOffset = () => {
  const vv = window.visualViewport;
  if (!vv) return;
  // offsetTop is the px the visual viewport is shifted DOWN inside the
  // layout viewport because the keyboard pushed it. Translate xterm UP
  // by the same amount so its bottom edge lines up with vv.bottom.
  container.style.transform = `translateY(${-vv.offsetTop}px)`;
};

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', applyKeyboardOffset);
  window.visualViewport.addEventListener('scroll', applyKeyboardOffset);
  applyKeyboardOffset(); // initial state
} else {
  // Fallback: very old browsers without VisualViewport API. CSS keeps
  // 100dvh on .terminal-host and DimsStateMachine handles keyboard as
  // a layout event. The 500ms echo-latency cost reappears here, but
  // only for that minority of clients.
  container.style.height = '100dvh';
}
```

cleanup 时 removeEventListener + 清 transform。

## 当前 CSS 用 dvh 的位置（迁移指引）

迁移到双通道时按以下规则改 CSS：

| 用途 | 当前 | 应改为 | 理由 |
|---|---|---|---|
| terminal-host (xterm 容器外层) | `100dvh` | `100lvh` | 键盘事件不应触发 ResizeObserver |
| app shell / page wrapper | `100dvh` | `100lvh` | 同上，避免布局跟键盘联动 |
| 全屏 modal (登录、反馈 dialog) | `100dvh` | `100dvh` | 这些应跟键盘缩（避免 modal 被键盘盖一半） |
| min-height: 100dvh | 同上原则 | 按用途选 lvh / dvh | 视该容器是否需要"键盘自适应" |

迁移落地时枚举 `web/src/styles/*.css` 中所有 `dvh` / `vh` 单位逐项决策。

## 风险与未覆盖

- **ResizeObserver 不触发场景**：iOS Safari 在某些极端 layout 下
  可能不触发 ResizeObserver（已知报告 in xterm.js#3450 等）—— 此时状态
  机卡在 `unmeasured`，xterm 永不 mount。需要兜底：mount 后 `MAX_WAIT_MS`
  无 ResizeObserver callback 强制走"用 container.clientHeight 直接量"路径。
  `MAX_WAIT_MS = 1500ms` 与 server 兜底对齐。
- **测量误差**：ResizeObserver `contentBoxSize` 是 device-pixel 还是
  CSS-pixel 取决于 box 类型——`fit.proposeDimensions()` 已经处理这部分,
  我们直接用 `fit.proposeDimensions()` 而非自己量。
- **VisualViewport API 不可用**：iOS 12 / 老 Android WebView 不支持。
  降级到 dvh + ResizeObserver 路径，复现 ~500ms 回声延迟，但功能正确。
- **xterm 上沿超出 visual viewport 上沿**：键盘弹起 ≈ container 上移
  300px，xterm 顶部 300px 内容超出可见区。如果 cc cursor 在 grid 末行，
  prompt 仍在 vv.bottom 之上可见，banner 顶被遮——可接受。如果某种
  cc 状态把焦点放在 grid 顶（罕见），用户看不到——这种情况手动滚动到
  底部即可恢复，不引入特殊处理。
