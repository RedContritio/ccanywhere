# Tasks: m-fit-cols-off-by-one

整体 design 见 `proposal.md`。三 phase 顺序依赖。

## Phase 1: trace 补强（~30 LOC）

- [x] T1. diag.term 加 fontSize（feedback 自动带 — done 本笔同 ship）
- [ ] T2. `web/src/components/terminal-dims.ts` `dims.callback` payload
  扩展含 `cellWidth` / `cellHeight` / `paddingX` / `scrollBarWidth` /
  `containerWidth` (fractional)，从 xterm `_core._renderService.dimensions`
  + getComputedStyle 取
- [ ] T3. 新 ops-log event `fit.applied` 每次 `fit.fit()` 后调，含
  `{ cols, rows, cellWidth, containerW, computedOverflow }`
- [ ] T4. 验证 trace：feedback 一次 reload 后 ops-log 含上述字段

## Phase 2: 复现等待（user 操作）

- [ ] T5. user dogfood 触发"排版乱" + 反馈
- [ ] T6. 看 feedback `fit.applied` `computedOverflow > 0` 是否出现

## Phase 3: 修复（~20 LOC，依赖 Phase 2 确认）

- [ ] T7. `web/src/components/terminal.tsx` wrap fit 算后回检
  `cellW * cols ≤ containerW - safetyPx`（safetyPx ≈ 0.5）；超出 cols -= 1
- [ ] T8. test：mock containerW / cellW 各 sub-px 边界 case，验证 wrapper
  不让 cols 越界
- [ ] T9. dogfood 验证排版混乱不再发生
- [ ] T10. spec delta: `openspec/specs/web-frontend/terminal.spec.md` 加
  Requirement "cell × cols 不越界 container"

## 归档

- [ ] T11. ship 后归档 `openspec/changes/m-fit-cols-off-by-one/` →
  `openspec/archive/<date>-m-fit-cols-off-by-one/`
