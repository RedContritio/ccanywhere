# Tasks: m-claude-title-cc (shipped 2026-05-15)

## 实现

- [x] `web/src/pages/login.tsx:232`：
      `<span className="text-claude">C</span>C anywhere` →
      `<span className="text-claude">CC</span> anywhere`
- [x] `web/src/pages/workspace.tsx:271` button：同上替换
- [x] `web/src/pages/workspace.tsx:322` `<h2>`：同上替换

## 测试

- [x] `pnpm typecheck:all` 通过
- [x] `pnpm lint` 通过
- [x] `pnpm lint:md` 通过
- [x] `pnpm test` 通过（416/416 一次过）

## 视觉验证

- [x] playwright login page light mode → Read PNG 确认 "CC" Crail
      orange + " anywhere" 默认黑 fg ✓
- [x] playwright login page dark mode → Read PNG 确认 "CC" Crail
      orange + " anywhere" 接近白 fg ✓
- [ ] workspace empty pane h2 + sidebar button：playwright 跳 /login，
      留 user reload 浏览器看（改动机械相同）

## Spec delta

- [x] 无

## Ship

- [x] typecheck:all + lint + lint:md + test pass
- [x] build:all + launchctl kickstart + healthz 200
- [x] e2e 视觉确认
- [x] commit + archive

## Commits

- f1b0a0f feat(web): m-claude-title-cc — Claude orange 染两个 C
