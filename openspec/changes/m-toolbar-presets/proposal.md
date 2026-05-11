---
status: planned
---

# Proposal: m-toolbar-presets — 内置 toolbar 模板 + 一键应用 / swap

## 状态

planned。承接 m-user-prefs 完整自定义 toolbar（已 ship `2026-05-12`），
用户拿到 41-entry catalog 后下一步常见诉求是"加载现成模板而不是逐 cell 配"。

## Intent

`ToolbarEditDialog` 加 "应用模板" 入口，从内置 preset 列表选一套。

## Preset 候选

- **默认（termux 风格）**：当前 DEFAULT_TOOLBAR_LAYOUT
- **方向键在左**：当前的 mirror（用户早期提过 "方向键放右边"，反过来就有"放左边"诉求）
- **vim 风格**：含 hjkl 等
- **紧凑单行**：rows=1, cols=8（仅 Esc / Tab / arrows / Ctrl）

## 范围（估）

~80 LOC：

- `web/src/components/toolbar-presets.ts` preset 表（每个 preset = label
  + ToolbarLayout）
- `web/src/components/toolbar-edit-dialog.tsx` 顶部加 "应用模板" 下拉
- 选择 preset → 直接覆写 draft（不立即 save，用户仍可改）
- 1-2 测试 case

## 决策点（启动前定）

- preset 数量：先内置 3-4 个？预算 LOC 含/不含 preset 文本量
- 是否允许用户保存"我的 preset"到 user.preferences（更进一步个性化）
- 一键 swap 左右半作为单独按钮 vs 仅在 preset 列表里

## 关联

- 出处：`openspec/archive/2026-05-12-m-user-prefs/proposal.md` "不做" 段
- 依赖：m-user-prefs 完整 ship（已 ✓）
