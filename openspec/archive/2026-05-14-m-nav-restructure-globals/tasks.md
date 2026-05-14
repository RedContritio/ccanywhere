# Tasks: m-nav-restructure-globals (shipped)

## 准备 / 决策对齐

- [x] D1-D5 决策点对齐：D1 dialog / D2 不加 / **D3 不关闭**（与默认相
      反，用户选保持现状）/ D4 icon+文字横排 / D5 保持 B14 className

## 实现

### Topbar 重构

- [x] `web/src/components/workspace-header-actions.tsx`：
      `ActiveHeaderIcons` props 改为 `{ onShare, onReload }`，移除
      `onQuota` / `onSettings`。渲染 ↗ 分享 + ↻ 重连。
- [x] `web/src/pages/workspace.tsx`：
      - 加 `shareSessionId` state（`string | null`），handler
        `setShareSessionId(currentSession.id)` 触发 dialog
      - 顶层挂 `<ShareCreateDialog>`，sessionId 取自 state，projectName
        从 sessions + projects 计算
      - ActiveHeaderIcons 调用点改 props：`onShare={() =>
        setShareSessionId(currentSession.id)}` + 保留 onReload

### Sidebar 重构

- [x] 新增 `SidebarGlobalActions` 组件（在 workspace-header-actions.tsx
      内导出，避免 workspace.tsx 超 500 行 max-lines 限制）
- [x] `web/src/pages/workspace.tsx` 的 `<aside>` 底部：
      - 替换原单 button「反馈」为 `<SidebarGlobalActions>`：3 个等宽
        button「⚙ 设置 / 💰 配额 / 💬 反馈」
      - **D3=不关闭**：onClick 直接调对应 handler，不触发 closeDrawer
- [x] QuotaPanel / FeedbackDialog 仍挂在 workspace 顶层（现状不动）

### Session-list 清理

- [x] `web/src/components/session-list.tsx`：
      - 删 share button（↗）+ ShareCreateDialog import + state + 末尾
        dialog 挂载
      - × 删除按钮独立挂在行右侧，className `max-md:opacity-100
        md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:
        opacity-100` 维持 B14 mobile 常驻 fix
- [x] `useState` import 移除（已无引用）

### 抽取 EmptyPane

- [x] 新增 `web/src/components/empty-pane.tsx` 抽出 workspace.tsx 内部
      EmptyPane（为腾出行数容纳 ShareCreateDialog 顶层挂载，避免超
      max-lines 限制）

### 测试 update

- [x] 新增 `web/src/components/workspace-header-actions.test.tsx`：
      ActiveHeaderIcons（share + reload，无 quota/settings）/
      SidebarGlobalActions（3 button + 各自回调）/ DeadHeaderActions
      （Resume + 删除，无 share；busy 时 disabled）共 7 个 case
- [x] e2e `web/e2e/visual.spec.ts`：
      - 改名 `session row delete button stays visible on mobile (no
        hover)`：只断言 × visible + 用 toHaveCount(0) 反向断言 share
        按钮已从行内移除
      - 新增 `sidebar global actions (settings / quota / feedback)
        visible on mobile`：mobile drawer 打开后断言 3 个 button visible
- [x] 不加 active session topbar e2e case：SPA URL/store race 让
      `/workspace/<live_id>` 在 mock 路由下被 redirect 回 `/workspace`，
      e2e 不稳；改由 vitest unit (workspace-header-actions.test.tsx)
      保证按钮接线正确，screenshot 由 user 手动验
- [x] vitest 全绿：web 139 + 1 skipped；playwright mobile 3 passed

## Spec delta

- [x] 新建 `openspec/specs/ui-layout/spec.md`：4 个 Requirement (R1
      contextual/global 分离 + R2 mobile 不依赖 hover + R3 dialog 顶层
      挂载 + R4 不自动关 drawer) + 共 8 个 Scenario

## Ship

- [x] 必跑序列：typecheck:all + lint + lint:md + test (root 416 + web
      139) + build:all + launchctl kickstart + curl /healthz 200
- [x] commit message 含 archive 路径 + spec delta 摘要
- [x] 归档：`openspec/archive/2026-05-14-m-nav-restructure-globals/`
