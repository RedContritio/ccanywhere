---
status: planned-blocked-on-data
---

# Proposal: m-touch-scroll-one-line — 偶发滑动只一行 bug

## 状态

planned，Phase 1 trace 待先 ship，然后等用户反馈复现数据。模仿
m-fit-cols-off-by-one 的两阶段路径。

## Intent

用户反馈 `2026-05-11T04-08-20Z-d934f615` "基本正常 但是有几下只能滑动
一行"。手机滑动 xterm scrollback，绝大多数正常，但偶尔某次只滑 1 行不
连续滚动。

## Root cause 假设（待 Phase 2 数据确认）

终端触摸滚动在 `web/src/components/terminal-touch.ts` 自实现（绕过 xterm
内部 touchmove）。三态状态机 idle / scroll / selection，常量含
`TAP_THRESHOLD_PX = 6`、`TOUCH_STALL_THRESHOLD_MS = 30`、`cellHeight =
fontSize × 1.2`。可能边界：

| 假设 | 机制 |
|---|---|
| A. dyAccum 整除边界 | `lines = trunc(dyAccum / cellHeight)`；偶发某次 dyAccum 刚好小于 cellHeight 累计成 1 时被消费，后续帧 reset |
| B. stall threshold 误触发 | 30ms 间隔短于实际手指停顿，self-driven 累积器被错 reset |
| C. cellHeight cache 临界 | font-size 改动时 cellHeight cache 未更新（refreshCellHeight 调用时机）|
| D. scroll vs selection 状态机争抢 | 接近 TAP_THRESHOLD_PX 来回越过，scroll 启动后又被 long-press timer 误干预 |

## Phase 1: trace 补强（先做，~20 LOC）

在 terminal-touch.ts 触摸路径加 ops-log：

- `recordOp('touch.scroll.tick', { dyAccum, cellHeight, lines,
  intervalMs, mode })` 每次 touchmove 后调
- `recordOp('touch.stall.reset', { reason })` stall 触发时
- `recordOp('touch.mode.transition', { from, to })` 状态机切换

## Phase 2: 复现 + 定位（等用户数据）

用户下次触发"只滑一行"反馈，feedback ops 含上述 trace。

判据：
- `touch.scroll.tick` 序列里 `lines = 1` 单独出现 + 后续 dyAccum reset
  → 假设 A
- `touch.stall.reset` 在用户感觉应该继续 scroll 时触发 → 假设 B
- `cellHeight` 在 scroll 中途变 → 假设 C
- `touch.mode.transition` scroll → idle → scroll 短时反复 → 假设 D

## Phase 3: 修（~30 LOC，依赖 Phase 2 判据）

根据 root cause 改对应路径。预计：

- A: dyAccum 不在 trunc 后归零，保留余数累积
- B: stall threshold 上调 + 区分"短停 vs 真停"
- C: refreshCellHeight 改成 cellHeight 用 getter（每帧重算）
- D: long-press timer 在 scroll 状态下永不开启

## 关联

- 反馈出处：`~/.config/ccanywhere/feedback/2026-05-11T04-08-20Z-d934f615.json`
- 现有 touch 实现 spec：`openspec/specs/web-frontend/terminal.spec.md`
  "终端文本选择与触摸滚动接管" Requirement
