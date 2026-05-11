# Proposal: m-diag-enrich-v2 — feedback diag 全量采集（env / page / viewport vv / term cell）

## Intent

承接 `2026-05-09-m-feedback-diag-enrich` v1（基础 diag），ship 后 dogfood
发现真实 triage 缺关键变量：fontSize / cellWidth / userAgent / timezone /
visualViewport offsets / 物理屏幕尺寸 / locale / OS 主题偏好 / page state。

m-fit-cols-dpr misdiagnosis 的根因就是 diag 没记 fontSize（用户字号 8 我
按 default 13 反推 cols 应 ≈ 48，但实测 78 — root cause 我错误归类为
dpr bug，实际是字号设置）。

用户洞察："feedback 反正本地轮转性能不重要 → 全量采"。本笔按此审计
collectDiag 补 11 字段。

## 决策

- **不加 build sha / user kind（async fetch）** — 留独立 task
- **不破坏 v1 wire 形状** — 字段全为 optional 加项
- **collectDiag 路径补字段而非新建 endpoint** — feedback POST 路径不变

## 落地

`web/src/state/diag.ts` 扩 11 字段：

| 类 | 字段 |
|---|---|
| env (新) | userAgent / language / timezone / prefersColorScheme / prefersReducedMotion / visibilityState / hasFocus |
| page (新) | pathname / search / referrer |
| viewport (扩) | screenW / screenH / vvW / vvH / vvOffsetTop/Left / vvPageTop/Left |
| term (扩) | fontSize / fontFamily / scrollback / cursorBlink / cellWidth / cellHeight |

cellWidth / cellHeight 通过 xterm `_core._renderService.dimensions.css.cell`
读（同 FitAddon 内部口径）。

测试：`diag.test.ts` 加 5 cases / 改 mock helper 接收新字段。

ship: `96a02b1 feat(web): font-min 4 + reload-in-header + diag 全量采集 + CLAUDE.md 项目级约束`

（同笔 ship 含 FONT_SIZE_MIN 4 / reload button 搬 header / CLAUDE.md
项目级约束。本 archive 仅 cover diag 部分。）

## 形式化保证

| 性质 | 机制 |
|---|---|
| fontSize 不再缺失 | term.fontSize 直接读 xterm options |
| cellWidth/Height 与 FitAddon 同口径 | 同 `_core._renderService.dimensions` 路径 |
| 不破坏 v1 client | 全 optional 字段，旧 server 忽略不识 |
| triage 无须 grep ops | 关键变量进 diag，与 ops 解耦 |

## spec delta

`openspec/specs/rest-api/spec.md` POST /api/feedback 段更新 diag schema
描述含新字段（细节描述 spec 比较冗，倾向链接 wire types ref）。

## 历史教训

m-fit-cols-dpr misdiagnosis archive 标 "trace 缺 fontSize 是 root cause"。
本次补字段后类似 misdiagnosis 不会再因 diag 缺数据复发。
