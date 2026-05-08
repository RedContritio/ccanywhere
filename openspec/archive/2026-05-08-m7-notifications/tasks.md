# Tasks

## 1. 通知组件 + hook

- [ ] 1.1 `web/src/components/notification-banner.tsx`：default 状态显示条 + 按钮
- [ ] 1.2 `web/src/state/use-completion-notify.ts`：监听 sessions state 变化，触发通知
- [ ] 1.3 `web/src/state/use-background-poll.ts`：visibilitychange + 5s 轮询
- [ ] 1.4 `web/src/styles/app.css`：.notification-banner 样式（与主题色变量一致）

## 2. 接入 workspace

- [ ] 2.1 `web/src/pages/workspace.tsx`：mount banner + useCompletionNotify(navigate) + useBackgroundPoll
- [ ] 2.2 banner 放 header 下方一行，可被关闭按钮 dismiss（dismiss 不持久化，下次刷新还会出现 — 没必要 persist）

## 3. spec + 归档

- [ ] 3.1 `changes/m7-notifications/specs/web-frontend/spec.md`：ADDED Requirement: 浏览器桌面通知
- [ ] 3.2 验证：playwright e2e 不依赖通知（permission 在 chromium headless 默认拒绝）；本步骤仅手动验证 UI 渲染
- [ ] 3.3 merge 到 openspec/specs/web-frontend/spec.md
- [ ] 3.4 移到 archive/YYYY-MM-DD-m7-notifications/
- [ ] 3.5 commit "M7: browser desktop notifications on busy→idle"
