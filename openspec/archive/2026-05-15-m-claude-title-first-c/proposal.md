---
status: planned
---

# Proposal: m-claude-title-first-c — Claude orange 只染第一个 C

## 状态

planned。承接刚 ship `2026-05-15-m-claude-title-color`，user 反馈视觉太重：
"不要全部用橙色。只把第一个 C，换成这个颜色，其他保持颜色不变"。

## Intent

把 m-claude-title-color "整段 'CC anywhere' 染橙" 收窄到 "只第一个 C
染橙"：**C**C anywhere — 第一个 C 用 Claude Crail `#c15f3c`，其余字符
（"C anywhere"）保持继承父级 text-fg / hover:text-brand 行为。

## 落地点

3 处都把 className 上的 `text-claude` 拿掉，文字内容用
`<span className="text-claude">C</span>C anywhere` 替换 "CC anywhere"：

- `web/src/pages/login.tsx:232` `<h1>`：
  - 移除 h1 的 `text-claude` class
  - 内容 → `<span className="text-claude">C</span>C anywhere`
- `web/src/pages/workspace.tsx:271` 返回主页 button：
  - className 从 `... text-claude hover:opacity-80` 恢复到原
    `... hover:text-brand`（hover 时整体变 brand 蓝紫，但 span 自己
    的 `text-claude` color 是 element-level CSS，不被父 hover 继承
    覆盖，span 保持 Crail orange）
  - 内容 → `<span className="text-claude">C</span>C anywhere`
- `web/src/pages/workspace.tsx:322` `<h2>`：
  - 移除 h2 的 `text-claude` class
  - 内容 → `<span className="text-claude">C</span>C anywhere`

## 形式化保证

- span 的 `text-claude` color 在父元素 hover 切 brand 时不被继承覆盖
  （CSS `color` 是 element-level cascade；span 自己设了 color rule
  就 win over 父 hover 继承）
- token `--color-claude: #c15f3c` 定义不变（继续来自
  m-claude-title-color tokens.css）
- 三处标题的非首字符部分恢复 m-claude-title-color **之前** 的颜色行为
  （login h1 继承 text-fg；workspace button default fg + hover:text-brand；
  workspace h2 继承 text-fg）

## 范围

~6 LOC：3 处文字内容各 1 行（拆 span）+ 3 处 className 调整（login h1
移除 text-claude，workspace button 恢复 hover:text-brand 删 text-claude
+ hover:opacity-80，workspace h2 移除 text-claude）

## 不做

- 不动 token `--color-claude` 定义
- 不动其他 UI 颜色
- 不动 m-claude-title-color 的 .gitignore `.playwright-mcp/` 改动
  （已 ship）

## 关联

- 出处：user 反馈 2026-05-15
- 依赖：`2026-05-15-m-claude-title-color`
