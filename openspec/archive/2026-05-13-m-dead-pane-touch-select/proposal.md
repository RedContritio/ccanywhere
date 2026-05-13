---
status: planned
---

# Proposal: m-dead-pane-touch-select — dead pane 长按选择文本 fix

## Intent

User 报告：dead session pane 上 mobile 长按无法选择文本（active pane 工作）。

Root cause:

1. `terminal-touch.ts` 的 `setupTouchInteraction` 实现 ccanywhere 自己的
   long-press → 合成 xterm mouse event → selection 流程。active pane
   attach 它。
2. dead-session-pane.tsx 渲染 readonly xterm 但**未 attach**
   `setupTouchInteraction`。
3. `xterm-overrides.css` 在 `.xterm-viewport` 上设 `touch-action: none`
   阻止 OS gesture，同时也让 mobile 系统级长按 selection 失效（mobile
   browser 在 `touch-action: none` 上 suppress long-press contextmenu /
   text selection）。
4. xterm 自带的 selection 不会被 finger touch 触发（需要 mouse
   events），所以 dead pane 没有任何路径能进 selection 状态。

m-session-persistence P9 修过相邻 mobile 问题（弹键盘）；当时 fix 改成
`textarea.disabled = true` 解决了 input focus，但**没补 selection 路径**。
本次 fix 补这条。

## 决策

D1. **复用 setupTouchInteraction**：不写 dead-pane-specific helper，
    避免 long-press 计时 / mouse event 合成 / clipboard 复制 ~50 LOC
    duplication。setupTouchInteraction 现签名 `(container, term, fit)`
    把 fit 改 optional 支持 readonly 用法。

D2. **dead pane skip pinch-zoom**：fit undefined 时 onTouchStart 见
    `e.touches.length === 2` 立即 return（pinch path 完全跳过）。dead
    pane 是 readonly snapshot，fixed 100×30 cols / rows，pinch 改 font
    size 没有持久化语义 + 不重要。

D3. **scroll mode 保留**：dead pane scrollback=0，`term.scrollLines`
    实际是 no-op，但保留 scroll mode 入口让单指 drag 在 dead pane 上
    behave 一致（不阻止）。仅 selection 是真正修复点。

D4. **不增加 unit test**：mobile touch interaction 已 e2e 验过（active
    pane），dead pane 共享同一 handler；本次仅 wiring 改动 + readonly
    flag，单测增量收益低，手动 mobile 验即可。

## 落地点

**改写**：
- `web/src/components/terminal-touch.ts`：
  - `fit: FitAddon` → `fit?: FitAddon`
  - `onTouchStart` 2-finger 路径：`if (fit === undefined) return;` 跳过
    pinch
  - `onTouchMove` `fit.fit()` → `fit?.fit()`（满足 TS；运行时不变因
    pinchBase 仅在 fit defined 时 set）
- `web/src/components/dead-session-pane.tsx`：
  - import `setupTouchInteraction`
  - `t.open(container)` 后 `setupTouchInteraction(container, t, undefined)`
  - cleanup 时 call `handle.cleanup()`

## 形式化保证

F1. dead pane MUST 支持 mobile long-press（≥ 500ms 静止）→ 进入 xterm
    selection mode → finger drag 扩展 selection → touchend 复制到
    clipboard，与 active pane 行为一致。
F2. dead pane MUST NOT 响应 pinch-zoom（snapshot fixed dims，无 fit
    addon）。

## 不做

- 不为 dead pane 加 pinch-zoom 支持
- 不写 long-press unit test（touch event 单测复杂度高，收益低；已存在
  e2e 验证 active pane 同一 handler）
- 不动 `.xterm-viewport { touch-action: none }` overrides（仍由
  setupTouchInteraction 的 capture-phase preventDefault 接管 gesture）

## 范围估算

| 模块 | LOC |
|---|---|
| terminal-touch.ts | ~5 |
| dead-session-pane.tsx | ~10 |
| **总** | **~15 LOC** |

## Commit 边界

单笔 commit `fix(web): m-dead-pane-touch-select — dead pane 长按选择文本`。

## 关联

- 出处：user 反馈 "目前的最后一屏，没法长按选择文本"（2026-05-13）
- 关联 ship: m-session-persistence P9 (textarea.disabled = true) 修了
  键盘弹出但没补 selection 路径
