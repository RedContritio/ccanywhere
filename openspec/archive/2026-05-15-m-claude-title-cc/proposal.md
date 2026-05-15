---
status: planned
---

# Proposal: m-claude-title-cc — Claude orange 染两个 C

## 状态

planned。承接 `2026-05-15-m-claude-title-first-c`，user 反馈："两个 C
都用这个颜色吧"。span 范围从首字母 "C" 扩到 "CC"。

## Intent

把当前 "**C**C anywhere" 改成 "**CC** anywhere"——两个 C 都染 Claude
Crail `#c15f3c`，仅 "anywhere"（含前置空格）保持父级 fg / hover:text-brand
行为。

## 落地点

3 处都把 span 包裹范围从 `"C"` 扩到 `"CC"`：

- `web/src/pages/login.tsx:232` `<h1>`：
  - `<span className="text-claude">C</span>C anywhere` →
    `<span className="text-claude">CC</span> anywhere`
- `web/src/pages/workspace.tsx:271` button：同样替换
- `web/src/pages/workspace.tsx:322` `<h2>`：同样替换

## 形式化保证

- span 包裹两个 C；剩 " anywhere"（前置空格）保持原 color 行为
- workspace button hover 仍 `hover:text-brand`：hover 时 span 内两个
  C 保持 Crail orange（element-level CSS），"anywhere" 变 brand 蓝紫
- token `--color-claude: #c15f3c` 不变

## 范围

~3 LOC：3 处各 1 行内容修改（span 包裹范围从 `C` 改成 `CC`，文字
"C anywhere" 改成 " anywhere"）

## 不做

- 不动 token 定义
- 不动 className
- 不动其他 UI 颜色

## 关联

- 出处：user 反馈 2026-05-15
- 依赖：`2026-05-15-m-claude-title-first-c`
- 历史：`2026-05-15-m-claude-title-color`（全染，被 first-c 收窄）→
  `m-claude-title-first-c`（首字母染）→ 本次（两个 C 染）
