---
status: planned
---

# Proposal: m-nav-restructure-globals — 全局配置入 sidebar，分享入 session topbar

## 状态

planned。源自用户 2026-05-14 反馈："分享不应该放在 session 列表中，而应该
放到 session 页 topbar。其次，设置应该放在 sidebar 里，因为这是全局共享的
配置。quota 同理。" 同笔 fix B14 mobile hover-only 按钮 bug。

## Intent

按 **per-session 操作 vs 全局 user 配置** 的语义重新分布入口：

- **session 页 topbar** = 仅 per-session contextual 操作（重连 / 分享当前
  session）
- **sidebar** = 全局共享配置入口（设置 / 配额 / 反馈）
- **session-list** = 仅会话切换 / 删除单条（不再混入分享操作）

## 现状（已 grep 确认）

- `web/src/components/workspace-header-actions.tsx::ActiveHeaderIcons`：当前
  topbar 右槽 = 💰 配额 + ⚙ 设置 + ↻ 重连
- `web/src/components/session-list.tsx:92` 每行 ↗ 分享 + × 删除（B14 刚 fix
  mobile 常驻显示——本 change 删 ↗ 后该 fix 仅对 × 仍生效）
- `web/src/pages/workspace.tsx`：
  - `feedbackOpen` / `quotaOpen` state + `<FeedbackDialog>` / `<QuotaPanel>`
    挂载在 workspace 顶层
  - sidebar `<aside>` 底部仅有「反馈」`<Button>`（`workspace.tsx:292-302`）
  - topbar `ActiveHeaderIcons` 调 `setQuotaOpen` + `navigate('/settings')`
    （`workspace.tsx:399-403`）

## 重新分布（最终态）

### Session topbar `ActiveHeaderIcons`

- ↗ 分享当前 session（新增）
- ↻ 重连（保留 — 是 per-session 操作）
- ❌ 删 💰 配额
- ❌ 删 ⚙ 设置

### Sidebar aside 底部

- ⚙ 设置 → `navigate('/settings')`（新增）
- 💰 配额 → `setQuotaOpen(true)`（新增，触发同 QuotaPanel dialog；详见 D1）
- 💬 反馈 → `setFeedbackOpen(true)`（保留）

布局：横排 3 个 icon button + label（mobile drawer 宽 ≥ 280px 横排够）。

### Session-list 每行

- × 删除（保留）
- ❌ 删 ↗ 分享

### DeadHeaderActions（dead session 顶栏）

- Resume / 删除（保留现状，不加分享 — 见 D2）

## 配套逻辑（推导）

1. **「分享」按钮可见条件**：仅 live session + `!currentSession.deletedAt`。
   dead-resumable session 显示 DeadHeaderActions 不走 ActiveHeaderIcons，
   天然不显示分享按钮。
2. **ShareCreateDialog 调用点**：从 session-list.tsx 上移到 workspace.tsx
   顶层；`sessionId` 从 `currentSession.id` 取，不再从 list row 取。
3. **MySharesSection 不动**：`/settings` 的「我的分享」section 仍是查看 /
   管理已有分享的地方，不影响——只是**创建**分享入口集中到 topbar。
4. **session-list `setShareId` state 删**：连同 `<ShareCreateDialog>` 一起
   下移到 workspace。
5. **drawer 自动关闭**：mobile 上点 sidebar 的 ⚙ / 💰 / 💬 任一按钮后，
   drawer 自动 `closeDrawer()`——否则 dialog / 跳页时 drawer 还盖在上面。
   反馈和现状一样（current 「反馈」点完 dialog 弹出，drawer 仍开）。决定
   统一加 closeDrawer，见 D3。
6. **ActiveHeaderIcons 测试 update**：现有 unit/e2e 验 💰 + ⚙ 按钮存在的
   case 改成验 ↗ 分享存在 + 验 sidebar 上 ⚙ + 💰 存在。
7. **B14 fix 部分回退**：session-list.tsx:92 的 className 不再需要——share
   button 删了；× 删除按钮独立留下，className 简化（无需 group 容器，单
   按钮直接 mobile 常驻 / 桌面 hover 也 OK，但保持现 className 不变更省事）。

## 形式化保证

- **入口唯一性**：每个全局操作（设置 / 配额 / 反馈）在 UI 上**只有一处**
  入口（sidebar 底部），不再分散到 topbar。分享同理——只在 session topbar
  一处入口（创建分享），MySharesSection 只用于管理。
- **contextual / global 分离**：topbar 上的操作都依赖 `currentSession`
  上下文；sidebar 上的操作都与 session 无关（不读 `currentSession`）。
- **mobile parity**：所有新入口在 mobile drawer 打开后均可见 + 可点击，
  不依赖 hover。

## 决策点（已定 2026-05-14）

- **D1 = dialog**. 配额保持 QuotaPanel dialog 弹层（不拆 `/settings/quota`
  子路由）。
- **D2 = 不加**. DeadHeaderActions 不加分享按钮 — Resume + 删除已占满
  视觉密度。user 若要分享 dead session 可先 Resume 再分享。
- **D3 = 不关闭**. sidebar 三按钮点击后**不自动关闭** mobile drawer。
  与现状「反馈」一致；点完按钮 drawer 仍开，方便用户在 dialog / 跳页关闭
  后继续使用 sidebar 上下文。
- **D4 = icon+文字横排**. sidebar 底部三按钮均分宽度，icon + 文字（"⚙
  设置"）。
- **D5 = 保持**. session-list × 删除按钮 className 维持 B14 fix（mobile
  常驻 / 桌面 hover）。

## 范围（估）

~80-120 LOC + 测试 ~40 LOC：

- `web/src/components/workspace-header-actions.tsx`：
  ActiveHeaderIcons props 改（去 onQuota / onSettings，加 onShare）+
  渲染 ↗ + ↻（~15 LOC）
- `web/src/pages/workspace.tsx`：
  - 顶层新增 `shareSessionId` state + `<ShareCreateDialog>` 挂载（~15 LOC）
  - ActiveHeaderIcons 调用点改 props（~5 LOC）
  - sidebar aside 底部加 ⚙ + 💰 button + drawer 自动关闭 wrapper（~25 LOC）
- `web/src/components/session-list.tsx`：删 share button + setShareId
  state + ShareCreateDialog import（~20 LOC -）
- `web/src/components/session-list.test.tsx`（若存在）：删 share case
- `web/src/pages/workspace.test.tsx`（若存在）/ 或新建：加 sidebar
  globals + topbar share button case
- e2e：B14 已加的 `session row share/delete buttons stay visible` case
  改成 `session row only delete button visible (share moved to topbar)`；
  新增 `topbar share button on active session` + `sidebar settings /
  quota / feedback buttons visible on mobile`（~40 LOC）

## 不做

- **新增分享其他设备/历史 session 的 UI** —— 创建分享只能针对当前打开的
  session。要分享旧 session 需先切到那个 session 再点。
- **MySharesSection 改造** —— `/settings` 的我的分享 section 不动。
- **rebrand quota / settings icon** —— 💰 / ⚙ / ↻ 保持现 emoji，不引入
  lucide icon。
- **sidebar 折叠 / 展开偏好持久化** —— 当前 mobile drawer 是临时打开，
  桌面 sidebar 常驻。不改这个模式。

## 关联

- 出处：用户 2026-05-14 反馈 + 同笔 B14 mobile hover bug
- 依赖：B14 fix 已 ship（session-list × 按钮 mobile 常驻显示），本 change
  在此基础上继续重构
- spec delta：`openspec/specs/ui-layout/spec.md`（若不存在新建）记录"
  全局 vs contextual 入口分布原则"
- 关联 archive：`2026-05-12-m-design-system-unify`（toolbar config 移至
  /settings）+ `2026-05-13-m-share-static-export`（MySharesSection 引入）
