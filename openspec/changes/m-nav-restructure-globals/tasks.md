# Tasks: m-nav-restructure-globals

## 准备 / 决策对齐

- [ ] D1-D5 决策点对齐（见 proposal）。默认推荐：D1 dialog / D2 不加 /
      D3 全部自动关闭 / D4 icon+文字横排 / D5 保持 B14 className。

## 实现

### Topbar 重构

- [ ] `web/src/components/workspace-header-actions.tsx`：
      `ActiveHeaderIcons` props 改为 `{ onShare, onReload }`，移除
      `onQuota` / `onSettings`。渲染 ↗ 分享 + ↻ 重连。
- [ ] `web/src/pages/workspace.tsx`：
      - 加 `shareSessionId` state（`string | null`），handler
        `setShareSessionId(currentSession.id)` 触发 dialog
      - 顶层挂 `<ShareCreateDialog>`，sessionId 取自 state
      - ActiveHeaderIcons 调用点改 props：`onShare={() =>
        setShareSessionId(currentSession.id)}` + 保留 onReload

### Sidebar 重构

- [ ] `web/src/pages/workspace.tsx` 的 `<aside>` 底部：
      - 删原单个「反馈」 Button
      - 加 3 个 icon+文字 Button 横排：⚙ 设置 / 💰 配额 / 💬 反馈
      - 每个按钮 onClick 内部统一调 `closeDrawerThenDo(cb)` wrapper：
        `closeDrawer(); cb()`（mobile drawer 自动关闭）
- [ ] QuotaPanel / FeedbackDialog 仍挂在 workspace 顶层，由 state 控制
      （现状不动）

### Session-list 清理

- [ ] `web/src/components/session-list.tsx`：
      - 删 share button（↗）+ aria-label="分享 ..." 整段
      - 删 `setShareId` / `shareId` state + `shareProj` 计算 + 末尾
        `<ShareCreateDialog>` 挂载 + import
      - × 删除按钮保留，外层 className 维持 B14 mobile 常驻 fix
- [ ] 若 session-list.tsx 引入的 ShareCreateDialog 现在 0 引用 → 不删组
      件文件（workspace.tsx 还会用）

### 测试 update

- [ ] e2e `web/e2e/visual.spec.ts`：
      - 改名 / 改逻辑 `session row share/delete buttons stay visible on
        mobile`：现在只断言 × 删除按钮 visible（分享按钮已移除）
      - 新增 mobile case：active session topbar 显示 ↗ 分享按钮 + 点
        击弹 ShareCreateDialog
      - 新增 mobile case：sidebar 底部 ⚙ + 💰 + 💬 均 visible + 点击
        后 drawer 自动关闭
- [ ] 若有 workspace-header-actions 单测，update 断言：ActiveHeaderIcons
      不再渲染 💰 / ⚙
- [ ] vitest + playwright 全绿

## Spec delta

- [ ] 新建 / 更新 `openspec/specs/ui-layout/spec.md`：加 Requirement
      "导航入口按 contextual vs global 二分" + Scenario "active session
      topbar 不显示 settings/quota 入口；sidebar 不显示 share 入口"

## Ship

- [ ] 必跑序列：`pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm
      test` + `pnpm -F ccanywhere-web test` + `pnpm build:all` +
      `launchctl kickstart ...` + `curl /healthz` 200
- [ ] commit message 含 archive 路径 + spec delta 摘要
- [ ] 归档：`mv openspec/changes/m-nav-restructure-globals
      openspec/archive/<date>-m-nav-restructure-globals`
