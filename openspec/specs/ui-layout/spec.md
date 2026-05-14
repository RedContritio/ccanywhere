# Spec: ui-layout — workspace 导航入口分布

稳定 spec：workspace 页 UI 入口按 **contextual vs global** 二分。新增 /
重构入口前对照本 spec。

---

## Requirement R1: 入口按 contextual vs global 分离

workspace 页所有可点击的 UI 入口必须能明确归到下面两类之一，且渲染位置
对应：

- **contextual**：依赖 `currentSession` 才有意义的操作 → 渲染在 **session
  topbar**（`ActiveHeaderIcons` / `DeadHeaderActions`）
- **global**：与具体 session 无关、对整个 user 生效的操作 → 渲染在
  **sidebar**（顶部 header 处理认证 / 主题；底部 `SidebarGlobalActions`
  处理 settings / quota / feedback）

session-list 不渲染入口（仅切换 / 删除单条 session）。

### Scenario R1.1: active session topbar 仅含 contextual 操作

WHEN workspace 渲染 active live session
THEN topbar 显示 ↗ 分享当前 session + ↻ 重连
AND topbar **不**显示 ⚙ 设置 / 💰 配额 / 💬 反馈（这些是 global，归
sidebar）

### Scenario R1.2: dead session topbar 仅含 contextual 操作

WHEN workspace 渲染 dead-resumable session
THEN topbar 显示 Resume + 删除
AND topbar **不**显示分享 / 设置 / 配额 / 反馈

### Scenario R1.3: sidebar 底部仅含 global 配置入口

WHEN workspace 渲染 sidebar
THEN 底部 `SidebarGlobalActions` 显示 ⚙ 设置 / 💰 配额 / 💬 反馈三个等
宽按钮
AND sidebar 底部 **不**显示分享按钮（分享是 contextual，归 topbar）

### Scenario R1.4: session-list 每行仅含 session 维护操作

WHEN workspace 渲染 session-list 一行
THEN 行内仅 × 删除按钮可作为悬浮操作
AND 行内 **不**显示分享按钮（创建分享改由 topbar 触发）

---

## Requirement R2: mobile 上 contextual + global 入口均不依赖 hover

触摸设备没有 hover 状态。session-list 行的 × 按钮和 sidebar 全局按钮
在 mobile (`max-md`) 上必须**常驻可见**；hover-to-reveal 行为仅在
desktop (`md+`) 启用，减少视觉密度。

### Scenario R2.1: session-list × 按钮在 mobile drawer 中常驻可见

WHEN viewport 为 mobile (`<md`)
AND drawer 已打开
THEN session-list 每行的 × 删除按钮 visible 不需 hover
AND desktop viewport 下保持 `opacity-0 group-hover:opacity-100` 行为

### Scenario R2.2: sidebar 全局按钮在 mobile 上始终可见

WHEN viewport 为 mobile (`<md`)
AND drawer 已打开
THEN 设置 / 查看配额 / 反馈三个按钮均 visible 不需 hover

---

## Requirement R3: ShareCreateDialog 由 workspace 顶层挂载

session-list 不再持有 share dialog state；创建分享的入口集中到 session
topbar，dialog 由 `WorkspacePage` 顶层挂载，`sessionId` 来自当前
session。

### Scenario R3.1: 点击 topbar ↗ 触发 ShareCreateDialog

WHEN 用户在 active session topbar 点击 ↗ 分享按钮
THEN `ShareCreateDialog` open，`sessionId` 为当前 session 的 id
AND `projectName` 解析为该 session 对应 project 的 name（fallback 到
projectId 字符串）

### Scenario R3.2: 关闭 dialog 不影响其他 workspace 状态

WHEN 用户在 ShareCreateDialog 关闭 dialog
THEN `shareSessionId` 重置为 null
AND drawer / currentSession / 其他 dialog 状态不变

---

## Requirement R4: 点击 sidebar 全局按钮不自动关闭 mobile drawer

D3 决策：点击 ⚙ / 💰 / 💬 任一按钮后 mobile drawer 保持打开状态，与
现状一致。

### Scenario R4.1: 点击 sidebar 按钮后 drawer 仍打开

WHEN viewport 为 mobile，drawer 已打开
WHEN 用户点击 ⚙ 设置（或 💰 / 💬）
THEN 对应 dialog 打开 / 跳转至 /settings
AND drawer 不自动关闭

理由：用户可能在 dialog 关闭后继续使用 sidebar 上下文（如再点其他按钮）。
