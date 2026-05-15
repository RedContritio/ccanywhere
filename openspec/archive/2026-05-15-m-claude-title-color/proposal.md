---
status: planned
---

# Proposal: m-claude-title-color — "CC anywhere" 标题用 Claude 品牌色

## 状态

planned。user 直接提需求 2026-05-15。本次实施 + archive 同笔。

## Intent

把前端 UI 中 "CC anywhere" 字样出现的 3 处标题都加上 Claude 官方品牌
橙色（Crail `#C15F3C`），视觉上锚定 ccanywhere 与 Claude 的关联。

## Claude 品牌色

- **Crail** `#C15F3C` — 主品牌橙 / terracotta（OKLCH 0.70 0.14 45）

其它官方调色板（Cloudy `#B1ADA1` / Pampas `#F4F3EE` / White）本 change
不引入，scope 仅限标题文字色。

来源：mobbin.com/colors/brand/claude + brandcolorcode.com/claude。

## 落地点

- `web/src/styles/tokens.css`：`@theme` 块加 `--color-claude: #c15f3c`，
  tailwind 4 自动生成 `text-claude` / `bg-claude` 等 utility class。
  全局单值，不分 light/dark variant — Crail 在两种 mode 下对 ≥14pt bold
  标题文字 contrast ratio 满足 WCAG AA (≥3:1)。
- `web/src/pages/login.tsx:232` — `<h1>CC anywhere</h1>` 加 `text-claude`
- `web/src/pages/workspace.tsx:271-274` — sidebar 返回主页 `<button>`：
  默认 `text-claude`，hover 从原 `hover:text-brand` 改成
  `hover:opacity-80`（保持 Claude 色但变浅作交互反馈，避免橙→蓝紫的
  jarring 跳变）
- `web/src/pages/workspace.tsx:322-324` — empty pane `<h2>CC anywhere</h2>`
  加 `text-claude`

`new Notification('CC anywhere', ...)` (`use-completion-notify.ts:37`)
是 OS 通知 title，无 web CSS 控制，本 change 不动。

## 形式化保证

- `--color-claude` token MUST 仅用于 "CC anywhere" 字样的标题，不扩到
  其他 UI 元素（避免与 ccanywhere 自身 `--brand` 蓝紫视觉混淆）
- light + dark mode 下都用同一 hex `#c15f3c`
- 现有 `--brand`（ccanywhere `#4a5cde` / `#6b7cff`）保持不变；两个
  brand color 各司其职：`--brand` = ccanywhere 自身品牌；`--color-claude`
  = Claude 视觉锚

## 范围

~6 LOC：
- +2 tokens.css（新 token）
- +1 login.tsx（加 className）
- 改 1 workspace.tsx button（className 改 default + hover）
- +1 workspace.tsx h2（加 className）

## 决策点（已定）

- **单一色 vs light/dark variant**：单一色 `#C15F3C`。Crail 在两种 mode
  下 contrast 都 OK for 大字（h1 18px / h2 20px / button 14px bold 均
  ≥14pt 阈值）
- **workspace button hover 行为**：default `text-claude` + `hover:opacity-80`
  （而非 `hover:text-brand`）。理由：保持 Claude 视觉锚定，opacity 变化
  足以提示可交互，避免橙→蓝紫颜色跳变
- **是否引入 Pampas/Cloudy 背景色**：不引入。本 change 仅标题文字色

## 不做

- 不动 ccanywhere `--brand` 蓝紫色
- 不改其他文字色 / 按钮色
- 不引入 Claude logo 图标
- 不动 OS 系统通知标题
- 不引入 dark/light Claude 色 variant

## 关联

- 出处：user 直接提需求 2026-05-15
- 依赖：无
