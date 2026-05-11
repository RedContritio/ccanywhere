# Proposal: m-fit-cols-off-by-one — 偶发 cols 多 1 / TUI 排版混乱

## Intent

mobile dogfood 用户反馈：偶尔 cc TUI 排版混乱，最后一列内容被切 / 折行。
推断：fit-addon `proposeDimensions` 偶发返回 cols 比 xterm 实际能渲染的列
多 1，cc 按 N 列写入，xterm 物理只能容纳 N-1 列，最后一列溢出或回绕到下行。

## 与已归档 m-fit-cols-dpr-misdiagnosis 的关系

那次归档定性的是"用户字号 8 下 cols=78 是正确的"——cellWidth × cols ≈
container 宽度是匹配的，整体没有"高 dpr 偏差"系统性 bug。

本 proposal 关注**另一类 bug**：单次测量边界条件偶发越界 1 列。

## 复现 / 证据缺口

当前 ops-log 没记录足够信息判断是否触发：
- `dims.callback` payload 含 cols / rows / vvW / hostW 但**不**含
  `cellWidth` / `cellHeight` / `paddingX` / `scrollBarWidth` 这些 fit 算
  `cols` 的输入
- 用户报 "排版乱"，但 feedback ops-log 没法直接证明 cols 多了 1（缺少
  "xterm 实际渲染 N 列宽 = ?" 对照）

**第一步必须先补 trace**：

`collectDiag()`（feedback 自动带）应该收所有用户持久配置 — 之前漏了
`fontSize`（已修，diag.term.fontSize 出现在每次 feedback）。

剩余 trace 缺口仍在 ops-log 单帧级别：

1. `dims.callback` payload 加 `cellWidth` (css-px) / `cellHeight` /
   `paddingX` / `scrollBarWidth` / `containerWidth (fractional)`
2. 每次 `fit.fit()` 后 recordOp(`fit.applied`, { cols, rows, cellWidth,
   containerW, computedOverflow = cellWidth*cols - containerW })

`computedOverflow > 0` 即 cols off-by-one 触发——这是判断条件。fontSize
不再单独 record（diag 已带）。

## 候选 root cause

| 假设 | 可能机制 |
|---|---|
| A. fractional clientWidth × floor 边界 | fit 用 `Math.floor(containerW / cellW)`；当 `containerW / cellW = 77.9998…` 时 floor=77 正确；当浏览器某次给 `containerW = 78.0001` 时 floor=78 但实际渲染 cellW × 78 > containerW |
| B. visualViewport vs layout viewport 不一致 | ResizeObserver fires on layout viewport (375)，但 vvW=375.38 — 某些 RO callback 时机里 fit 误用 vv 测量 |
| C. xterm internal `_renderService.dimensions.css.cell.width` 与实际 DOM 渲染 cell 宽不一致 | xterm 算 cellW 用 fontMetrics × charWidth ratio，浏览器实际渲染加 letter-spacing / kerning rounding，偶尔多 sub-px |

## 修复候选（待 trace 数据后确认）

- 选 A：fit-addon 算 cols 时减 0.5 px safety margin，避免 floor 边界跨越
- 选 B：自己 wrap proposeDimensions，加 `cellW × cols ≤ containerW` 反向校验，
  超出则 cols -= 1
- 选 C：fork / patch `@xterm/addon-fit`（社区版本不动态修，维护成本高）

倾向 **选 B**（在 ccanywhere 自己代码加 safety wrapper，不动 fit-addon）：
- ~20 LOC
- 不引依赖 / 不破坏升级路径
- trace 数据出来后能精确量化 "off-by-one 发生率"

## Phases

### Phase 1 — trace 补强（前置，~30 LOC）

- mount 时 record `terminal.config { fontSize, dpr, renderer, charWidth }`
- `dims.callback` 加 `cellWidth/cellHeight/paddingX/scrollBarWidth/containerWidth`
- `fit.applied` 新 ops-log event 含 `computedOverflow`

### Phase 2 — 等触发 + 定位（用户操作）

- user dogfood 复现"排版乱"时 feedback
- 看 `computedOverflow > 0` 是否出现 / 频率多少

### Phase 3 — 修（选 B safety wrapper，~20 LOC）

- 自己 wrap fit proposeDimensions：算完 cols 后回检 `cellW * cols <= containerW`，
  超出 cols -= 1
- 加 test：mock cellW / containerW 各 sub-pixel 边界 case

## 与已 ship 改动的关系

- `FONT_SIZE_MIN = 4`（同笔 ship 但独立）：用户希望更小字号；与 fit
  off-by-one 不冲突，可能加大触发频率（更小 cell → 更密的边界）
- m-multi-user / quota / 键盘 resize（已 ship）：无直接关联

## 不做

- 不引 ccanywhere dep（@xterm/addon-fit 不升级 — 没有公开 fix 提案）
- 不做 "整体测量重写"（已确认整体测量对，仅 off-by-one）
- 不在 phase 1 之前修代码（瞎修可能 mask 真 root cause）
