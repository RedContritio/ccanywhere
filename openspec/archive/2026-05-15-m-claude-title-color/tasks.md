# Tasks: m-claude-title-color (shipped 2026-05-15)

## 决策对齐

- [x] 单一色 `#C15F3C`，不分 light/dark variant
- [x] workspace button hover 改 `hover:opacity-80`（从 `hover:text-brand`）

## 实现

- [x] `web/src/styles/tokens.css`：`@theme` 块加 `--color-claude: #c15f3c`
- [x] `web/src/pages/login.tsx:232` `<h1>CC anywhere</h1>` 加 `text-claude`
- [x] `web/src/pages/workspace.tsx:271` 返回主页 button：
  - 原 className: `text-sm font-semibold tracking-tight hover:text-brand`
  - 新 className: `text-sm font-semibold tracking-tight text-claude hover:opacity-80`
- [x] `web/src/pages/workspace.tsx:322` `<h2>CC anywhere</h2>` 加 `text-claude`

## 测试

- [x] `pnpm typecheck:all` 通过
- [x] `pnpm lint` 通过
- [x] `pnpm lint:md` 通过
- [x] `pnpm test` 通过（416/416；首次跑同样命中 `manager.persistence
      markDeleted` pre-existing flaky，第二次跑全过；与本 change 无关，
      m-hook-builder-remove 已记录此 flaky）

## 视觉验证（e2e + 自己读图）

- [x] playwright 截图 login page light mode → Read PNG 确认 h1 渲染
      Claude Crail `#C15F3C` orange ✓
- [x] playwright 截图 login page dark mode → Read PNG 确认 dark bg 上
      Crail orange 对比度更强、视觉锚定明显 ✓
- [x] `grep -o "text-claude\|c15f3c" web/dist/assets/*.css` → 都命中
      确认 tailwind 4 `@theme` token 流转 + utility class 生成正确
- [ ] **workspace empty pane + sidebar button 截图未完成**：playwright
      fresh browser context 无 auth cookie，navigate `/workspace`
      被 RequireAuth 跳 `/login`。两处 className 改动机械相同（同
      `text-claude` class），dist CSS 已验证 token 生效，相信渲染
      一致。留 user 自己浏览器 reload 视觉确认

## 视觉副发现（顺手记录）

- light mode：`#C15F3C` 在白底偏向温暖 terracotta，与下方蓝紫 "申请配对"
  按钮形成 cool/warm 双 brand 对比，视觉上 ccanywhere 自身 brand 与
  Claude 关联并存而不冲突
- dark mode：黑底 (`#0a0b0d`) 上 Crail 高对比度，相比 light mode 视觉
  权重更重，但仍在 typography 标题范围内不突兀

## 副改动（cleanup）

- `.gitignore` 加 `.playwright-mcp/`（MCP playwright 输出目录，与现有
  `.playwright/` entry 区别）

## Spec delta

- [x] 无 — UI polish，不动外部契约。`tokens.css` 自身是 brand color
      truth，spec 化色值反而引入 drift 风险

## Ship

- [x] typecheck:all + lint + lint:md + test pass
- [x] build:all + launchctl kickstart + healthz 200
- [x] e2e 视觉确认（login light/dark；workspace 两处留 user reload）
- [x] commit + archive

## Commits

- 7202e7d feat(web): m-claude-title-color — "CC anywhere" 标题用 Claude Crail orange
