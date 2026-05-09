# Proposal: M-mobile-fit-timing — 客户端尺寸生命周期状态机

## Intent

dogfood 反馈 7aed65ae 的 trace ops 直接证明：mount 时 `fit.fit()` 同步
量出错误尺寸（mobile container layout 还在 transition），把 75×61 这种
临时值 send 给 server，cc 据此画 banner+chat 占满 75×61 grid，但屏幕
viewport 只显 23 行。7.5 秒后 ResizeObserver 第一次 callback 才纠正
到 75×23，cc SIGWINCH 重画——用户感知"初始化卡顿、滑不到底"。

Timeline 直接证据：
```
30237 ms  ws.connect
30547 ms  term.reset (snapshot)
30553 ms  term.write source=snapshot len=4159 chunked
38074 ms  term.resize from {cols:75, rows:61} to {cols:75, rows:23}
```

本提案**不**用任何"等 N ms 再 fit / sanity 阈值跳过 / 检测特定 transition
关键字"这类绕开手段——这些都是赌时序。改用显式状态机：把"客户端测出
的 cols/rows 何时算可信"建成一个有限状态系统，状态转换由 ResizeObserver
事件 + 静默判定驱动。

## Scope

两条正交的事件通道，各自精确覆盖一类语义不同的 viewport 事件：

**Layout viewport 通道**（处理 drawer / orientation / Safari toolbar /
dialog 等会真正改变 cc 可见尺寸的 layout transition）：

- 客户端尺寸生命周期状态机：`unmeasured → awaiting-quiescence → stable`，
  `stable` 之后保持稳定模式。
- mount 时**不**同步调 `fit.fit()`、**不** send resize、**不** open xterm
  到容器（先放 placeholder 占位）。所有 IO 推到 `stable` 转换瞬间触发。
- ResizeObserver 是 layout 通道唯一事件源。每次 callback 重置 quiescence
  计时器。
- 静默判定（quiescence）的阈值由"layout transition 上限 × 安全余量"推导，
  不拍数字。

**Visual viewport 通道**（处理软键盘弹起 / 收起，**不** 改变 cc 可见尺寸，
仅是 visual viewport 被 overlay）：

- VisualViewport API (`window.visualViewport`) 是该通道唯一事件源。
- 键盘事件触发 xterm 容器 DOM `translateY(offsetTop)` 整体上移让 cursor
  可见。**不** 调 fit、**不** send resize、cc 不感知键盘。
- 不需要 quiescence——VisualViewport 报告的是 OS-level commit 后的稳态
  值，没有"半稳态"。
- CSS 必须用 `100lvh` (large viewport) 锚定 layout，让键盘不污染
  ResizeObserver 路径；当前 `100dvh` 把键盘当 layout 事件是语义错配。

不包含：

- 不改 server 端 `1.5s 兜底`——它是降级路径，本方案让正常路径永远比兜底先到。
- 不改 xterm 的 fit addon 或 ResizeObserver semantics——我们只改 *什么时候*
  调用它们，不改实现。
- 不修复 cc 在 SIGWINCH 后没清屏导致的"两份 banner"现象——那是 cc 行为
  问题，与本提案的尺寸生命周期正交。

## Approach

**核心建模**：客户端测出的 `(cols, rows)` 在生命周期中有三种状态：

```
unmeasured              ResizeObserver 还没 callback 过
        │ first callback
        ▼
awaiting-quiescence     至少有一次测量；arm timer at +QUIESCENCE_MS
        │ ↺ 后续 callback：reset timer
        │ timer 自然到期（无新 callback 打扰）
        ▼
stable                  尺寸已稳定，IO 解锁
        │ 后续 callback
        ▼
stable                  立即 fit + send resize（layout 已稳，无需再等）
```

**关键约束**：

1. mount 时 `<TerminalView>` 渲染 placeholder，不创建 xterm `Terminal`
   实例、不调 `term.open(container)`、不 send resize。
2. ResizeObserver 安在 placeholder container 上，是唯一尺寸事件源。
3. 进入 `stable` 是**一次性**触发：才创建 xterm、才 `term.open`、才
   `fit.fit()`、才 send first resize。后续 stable 中的 callback 走轻量
   路径（即时 fit + send）。
4. WebSocket 在 mount 时即可建立连接（与尺寸状态机解耦）。server 端
   "等首个 resize 才发 initial state" 的契约（已实现）兜住竞速：connect
   早于 stable 时 server 等；stable 触发 send resize；server 收到才发
   snapshot/output。

`QUIESCENCE_MS` 推导：

```
QUIESCENCE_MS = LAYOUT_TRANSITION_UPPER_BOUND_MS × SAFETY
              = 250 × 1.2
              = 300
```

来源：Material Design `large` transition 300ms 上限、iOS Safari toolbar
~200ms、CSS Animations spec 推荐 ≤ 300ms。SAFETY=1.2 吸收一帧抖动。

## Out of scope

- cc 在 SIGWINCH 后渲染叠加（"两份 banner"）—— cc 行为，独立修。
- ws-protocol output-before-snapshot 违反 spec —— 已开 task #28
  M-ws-init-state-gating。

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| client 永不在 layout 动态时 send 尺寸 | `awaiting-quiescence` 不出 IO |
| server 1.5s 兜底永不在常规 mount 路径触发 | quiescence ≤ 300ms ≪ 1500ms，stable 永远先到 |
| cc 第一次 SIGWINCH 收到的就是 stable 值 | mount 不发 resize，server 等首个 resize 才 spawn 后续路径，第一次资源对齐 |
| **键盘事件不触发 cc SIGWINCH** | visual viewport 通道只改 DOM transform，不进入 layout 通道；CSS `100lvh` 让 ResizeObserver 不响应键盘 |
| **键盘弹起无回声延迟** | DOM translate 跟随 visualViewport.offsetTop 即时生效，cursor 行立即可见 |
| 两通道事件互不重叠 | layout viewport 与 visual viewport 是浏览器规范定义的正交概念；ResizeObserver 在前者上 fire，VisualViewport.resize 在后者上 fire |
| layout pathological 持续抖动 (>1.2s) 时降级 | server 1.5s 兜底用 spawn-default 80×24 发 snapshot，pathology 比现状不更糟 |
