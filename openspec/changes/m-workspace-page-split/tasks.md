# Tasks: m-workspace-page-split

## 决策对齐

- [ ] useWorkspaceRouting 测试用 MemoryRouter
- [ ] dialogs (NewSession / Feedback / Quota / ShareCreate) 仍在
      workspace.tsx 顶层挂载

## 实现

- [ ] `web/src/state/use-workspace-routing.ts`：导出
      `useWorkspaceRouting(id, sessions, navigateOpts)`。内部含
      fetchProjects / fetchSessions / loadActiveSession 初始 trigger +
      URL ↔ store 同步 + stale URL recovery 三段
- [ ] `web/src/components/workspace-main-pane.tsx`：props 接收
      `currentSession` / `currentProject` / `wsConnection` /
      `liveSessionState` / `onOpenNew` / `onDelete` / `onResume` /
      `onWsConnected` 等，渲染 5 分支
- [ ] `web/src/components/workspace-sidebar-header.tsx`：props
      (`label`, `onLogout`, `onBackToHome`)，渲染顶部 header JSX
- [ ] 改 `web/src/pages/workspace.tsx`：删 `:110-136` + `:225-235` +
      `:262-290` + `:314-456` 对应段；替换为 hook 调用 + 子组件挂载

## 测试

- [ ] `web/src/state/use-workspace-routing.test.ts`：
  - URL 有 :id 时同步 store
  - URL 无 :id 时优先 currentSessionId；候选必须 live
  - stale URL 5s 后 navigate 回 /workspace；session 中途出现取消跳转
- [ ] `web/src/components/workspace-main-pane.test.tsx`：5 分支 smoke
      render
- [ ] e2e (playwright) 现有 4 个 case 全过（视觉无变化）

## Spec delta

- [ ] 无 — 前端 refactor，URL 路由行为不变

## Ship

- [ ] typecheck:all + lint + lint:md + test + e2e pass
- [ ] build:all + launchctl kickstart + healthz 200 + 浏览器视觉对比
- [ ] commit hash:
