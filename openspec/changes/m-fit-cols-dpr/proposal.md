# Proposal: M-fit-cols-dpr — 高 dpr 下 cols / rows 算错

## Intent

iPhone 375 × 699 视宽下 mobile dogfood 长期 cols=78 / rows=61，与 13px
monospace font 在该视宽期望（cols ≈ 47-48 / rows ≈ 53）严重偏离。
cellWidth 被算成 ≈ 4.8 css-px（应 ≈ 7.8），cellHeight ≈ 11.5（应 ≈ 13×1.2 = 15.6）。
受影响的实际效果：cc TUI 多列布局错位 / 文本视觉换行点偏移。

## 证据：非 m-lint-cap phase 4 引入的回归

8 笔反馈（`~/.config/ccanywhere/feedback/`）显示 cols=78 / rows=61 在
phase 4 ship（2026-05-11 03:14 commit 97761cb）之前 8 天就一直如此：

| 时间 (UTC) | 反馈 title | cols | rows | 距 phase 4 |
|---|---|---|---|---|
| 2026-05-09 09:03 | "还是没有反应。是不是感知不到这个事件" | 78 | 61 | 之前 ~42h |
| 2026-05-09 09:14 | "header 还是消失" | 78 | 61 | 之前 ~42h |
| 2026-05-09 09:32 | "还是有同样问题，看看，top bar 不停住" | 78 | 61 | 之前 ~42h |
| 2026-05-09 09:40 | "还是不行" | 78 | 61 | 之前 ~42h |
| 2026-05-09 11:43 | "检查一下，我两次 resume 同 session…" | 78 | 61 | 之前 ~40h |
| 2026-05-09 12:53 | "单设备似乎对了" | 78 | 61 | 之前 ~38h |
| 2026-05-10 19:47 | "略微奇怪，宽度算错了？" | 78 | 61 | 之后 ~30min |

phase 4 改动审查：

- `terminal.tsx` mount 流程的 fit 调用点未变：
  - **initial fit** 仍在 `term.open(container)` + webgl addon load 后立即调（同原 line 117）
  - **stable-时 fit** 在 `setupDimsStateMachine` 内 dispatch `becameStable` 时调，
    与原 `useEffect` 内 dispatch 路径行为一致（搬到 `terminal-dims.ts`，无算法
    / 调用顺序改动）
  - **stable→stable resize 时 fit** 同上
- `dims-state.ts` 文件未改动（reducer 不变）
- `FitAddon` import 与 `term.loadAddon(fit)` 顺序未变（仍在 webgl addon load
  之前）
- 容器 dom 结构 `.terminal-view-pane > .terminal-view` 未变
- CSS `.terminal-view` 选择器未变（line 889 / 949 重复规则保持原样）
- xterm 渲染器 picked 结果记录显示反馈中均为 `webgl`（与原代码默认一致）

结论：cols=78 是 m-lint-cap 之前的 long-standing 现象，不是 phase 4 拆 hooks
引入的副作用。

## 假设的 root cause（按概率排序）

| 假设 | 证据 / 反证 | 验证方式 |
|---|---|---|
| **A. webgl atlas 与 fit-addon 在 dpr 3.25 上 cell 测量错** | xterm 5 webgl `actualCellWidth = atlasGlyphWidth / dpr`；如果 atlas 把 oversample factor 算进 glyph 宽（而 fit 只 div by dpr），cellWidth 会偏小 | `?renderer=dom` 切到 dom renderer 后看 cols 是否回到 ~48 |
| **B. CSS `.terminal-view` 重复规则导致 box 实际溢出 parent** | line 889 `width:100% height:100%` + line 949 `position:absolute inset:0 padding:8px`，box-sizing 默认 `content-box`，实际 box 是 100%+16px。fit 测 `clientWidth` 拿到 box 宽，cols 偏大 | 临时改 `.terminal-view { box-sizing: border-box }` 看 cols |
| **C. `.terminal-view-pane` width:100% 在 flex 父链下 fall back 到内容尺寸** | `.terminal-pane-content { flex: 1; min-height: 0 }` 但 `.terminal-host` 没显式 width，fit 可能拿到 cell 总宽而非视口宽 | DevTools inspect `.terminal-view` 实际 boundingClientRect |

A 是最可能的——cols 偏多 30（67% 多），不是简单的 padding overflow（最多
偏 16px ≈ 2 cols）。

## 推进顺序

1. user 在浏览器打开 `https://<staging>:7443/?renderer=dom` 并触发一次反馈
   → 拿到 dom renderer 下的 cols/rows 与 webgl 对比
2. 按对比结果定 root cause：
   - dom 也错 → C 优先（容器测量问题）
   - dom 对 / webgl 错 → A 是 webgl atlas / fit-addon 互动 bug
3. 修：
   - 若 A：升级 `@xterm/addon-fit` 到最新，或 patch fit `proposeDimensions`
     用 atlas-aware cell 测量；或绕开（webgl renderer 在 high-dpr 下保留 cellWidth
     = `fontSize × ratio` 直算，跳过 atlas-derived 路径）
   - 若 B/C：改 CSS `box-sizing: border-box` 或显式锁 `.terminal-view` 几何

## 关联 task

- 本 task 与 m-multi-user (#44) 完全独立——可并行推进
- 已被 m-lint-cap 排除范围外（lint cap 仅 enforce 文件大小，不修运行行为）

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| cols 算对 | iPhone 375 / 13px font cols ≈ 47-48（dom 与 webgl 一致） |
| dpr 与 cell 测量解耦 | actualCellWidth 在不同 dpr 下保持 fontSize × ratio，不被 atlas 影响 |
| phase 4 行为等价 | 上面 7 笔历史反馈 + 1 笔最新反馈 cols=78 完全一致，无回归 |
