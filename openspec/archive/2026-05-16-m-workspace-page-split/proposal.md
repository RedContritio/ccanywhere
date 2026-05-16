---
status: planned
---

# Proposal: m-workspace-page-split — workspace.tsx 488 行分层

## 状态

planned。`web/src/pages/workspace.tsx` 当前 488 行单组件：

- 12 个 zustand selector hook (`:51-69`)
- 6 个 useState (`:72-77`, `:84`, `:89-90`, `:181-182`)
- 5 个 useEffect (`:92-96` fetch / `:110-136` URL ↔ store sync /
  `:139-143` reset on switch / `:225-235` stale URL recovery /
  `:243-245` close drawer on switch)
- 200+ 行 JSX (`:247-486`)，含 5 个 EmptyPane 分支 + 顶 sidebar header
  60 行 + 顶 main header 60 行

单文件读起来还能跟上，但小改 (新增 dialog / 路由分支) 都增重。

## Intent

抽 3 段独立逻辑：

1. **`useWorkspaceRouting(id, sessions, ...)` hook** — 吃 `:110-136`
   (URL ↔ store ↔ remote active session 三向同步) + `:225-235` (stale
   URL 5s 后回 /workspace)
2. **`<WorkspaceMainPane>` 组件** — 吃 `:314-456` 的 5 分支渲染
   (sessionsError 失败 / 无 :id 主页 / :id 找不到 session (loading vs
   gone) / 未登录 / 实际渲染 TerminalView 或 DeadSessionSnapshot)
3. **`<WorkspaceSidebarHeader>` 组件** — 吃 `:262-290` aside header JSX
   (CC anywhere 标题 + label + ThemeCycleButton + 登出 Button)

主组件保留：state + dispatch + drawer 容器 + dialog 挂载点。

## 形式化保证

`useWorkspaceRouting` MUST：

- URL 有 :id 时同步 `useUiStore.currentSessionId` +
  `useActiveSessionStore.remoteActiveSessionId`
- URL 无 :id 时按优先级 (currentSessionId > remoteActiveSessionId) 挑
  候选 navigate replace；候选必须对应非删除 session 才生效
- stale URL（:id 找不到 live session 且 `!loading && !error`）5s 后回
  /workspace；候选途中 session 出现取消跳转

`<WorkspaceMainPane>` MUST：

- 受控组件（props in / event out），不直接访问 zustand store
- 5 分支渲染等价于现状 `:314-456`

## 落地点

- 新建 `web/src/state/use-workspace-routing.ts` (~70 LOC) — hook + 单测
  fixture
- 新建 `web/src/components/workspace-main-pane.tsx` (~150 LOC)
- 新建 `web/src/components/workspace-sidebar-header.tsx` (~30 LOC)
- 改 `web/src/pages/workspace.tsx` —— 减到 ~180 行（state + dispatch +
  外壳 JSX + dialog 挂载）

## 范围

~150 LOC 主文件减 / +200 新文件 / 净 +50 但分模块。

## 决策点（启动前定）

- `useWorkspaceRouting` 测试粒度：MemoryRouter（更真实）vs mock react-
  router-dom hooks。倾向 MemoryRouter
- WorkspaceMainPane 是否吸收 4 个 dialog (NewSession / Feedback /
  Quota / ShareCreate)：**不吸收**。dialog 是页面级 modal，留在 workspace
  顶层挂载更合理

## 不做

- 不重新拆 zustand store（12 个 selector hook 已按 store 模块化）
- 不引入新 routing 库
- 不改 NotificationBanner / SessionList / TerminalView 接口

## 关联

- 出处：本评审 B1
- 依赖：无
