# Tasks: m-claude-title-first-c (shipped 2026-05-15)

## 实现

- [x] `web/src/pages/login.tsx:232` `<h1>`：
  - 移除 `text-claude`
  - 内容 → `<span className="text-claude">C</span>C anywhere`
- [x] `web/src/pages/workspace.tsx:271` button：
  - className 恢复到 `text-sm font-semibold tracking-tight hover:text-brand`
  - 内容 → `<span className="text-claude">C</span>C anywhere`
- [x] `web/src/pages/workspace.tsx:322` `<h2>`：
  - 移除 `text-claude`
  - 内容 → `<span className="text-claude">C</span>C anywhere`

## 测试

- [x] `pnpm typecheck:all` 通过
- [x] `pnpm lint` 通过
- [x] `pnpm lint:md` 通过
- [x] `pnpm test` 通过（416/416 一次过，未碰 manager.persistence flaky）

## 视觉验证（e2e + 自己读图）

- [x] playwright login page light mode 截图 → Read PNG 确认：第一个
      C 是 Claude orange `#c15f3c`，"C anywhere" 默认黑色 fg ✓
- [x] playwright login page dark mode 截图 → Read PNG 确认：dark bg
      上第一个 C orange，"C anywhere" 接近白色 fg ✓
- [ ] workspace empty pane h2 + sidebar button：playwright fresh
      context 无 auth cookie，跳 /login。两处改动机械相同（同 span
      包裹首字母），login 已验证生效，相信渲染一致。留 user 自己
      浏览器 reload 看

## Spec delta

- [x] 无 — UI polish

## Ship

- [x] typecheck:all + lint + lint:md + test pass
- [x] build:all + launchctl kickstart + healthz 200
- [x] e2e 视觉确认（login light/dark；workspace 留 user reload）
- [x] commit + archive
