# Tasks

## 实现

- [ ] `src/share/render-assets.ts` `header.page` 块加：
  - `position: sticky;`
  - `top: 0;`
  - `background: var(--bg);`
  - `z-index: 10;`
  - 保留现有 padding-bottom / margin-bottom（layout 不破）

## BACKLOG

- [ ] 从 BACKLOG.md 删 B20 条目

## 测试

- [ ] `src/share/render.test.ts` 现有 case 全过（HTML 输出含 header.page，CSS 不影响测试断言）
- [ ] e2e share-view.spec.ts 现有 case 全过（视觉无 layout regression）
- [ ] 手测 / e2e 截图：share 页向下滚动应保持 header 项目名 + meta 可见

## Spec delta

- [ ] 无 — 仅 CSS 调整，HTML 结构 / share API 不变

## Ship

- [ ] typecheck:all + lint + lint:md + test pass
- [ ] build:all + launchctl kickstart + healthz 200
- [ ] commit hash:
