# Tasks: m-design-system-unify (planned)

## Phase 0 — 启动前对齐（用户拍板）

- [x] T0.1. 用户审 proposal 整体方向（D1-D10）
- [x] T0.2. 用户拍 DP1-DP8 决策点（"全部默认先"——见 proposal DP 段已锁定）

## Phase 1 — C1 infra（提交边界）

- [ ] T1.1. `web/package.json` 加 deps（tailwind / postcss /
  tailwind-animate / cva / clsx / tailwind-merge / lucide-react /
  @radix-ui 必要 primitive）
- [ ] T1.2. `web/tailwind.config.ts` 配置（dark mode / content path /
  theme.extend 注入 tokens）
- [ ] T1.3. `web/postcss.config.cjs`
- [ ] T1.4. `web/src/styles/tokens.css`（color / spacing / radius / shadow
  / fonts / z-index 全量 tokens）
- [ ] T1.5. shadcn copy base 组件（button / input / dialog / sheet / tabs
  / dropdown-menu / toast / badge / select / switch / separator / label
  / scroll-area）
- [ ] T1.6. `web/src/main.tsx` import tokens.css + 全局 font
- [ ] T1.7. 旧 `app.css` 暂不删（C6 才删）；新旧并存让验证可对照
- [ ] T1.8. C1 commit + healthz 验证

## Phase 2 — C2 abstractions + store 拆分

- [ ] T2.1. `web/src/components/dialog-base.tsx`（统一 header / close /
  footer pattern）
- [ ] T2.2. `web/src/components/list-base.tsx`（紧凑 list view）
- [ ] T2.3. `web/src/components/status-badge.tsx`（SessionState 4 状态映射）
- [ ] T2.4. `web/src/state/projects.ts` 拆出（保持 `useSessionsStore`
  hook 入口 API 不变）
- [ ] T2.5. 调用方迁移（grep 找所有 `useSessionsStore` 直接读 projects
  的处，导入新 hook）
- [ ] T2.6. 单元测试（DialogBase / ListBase / StatusBadge / projects
  store）
- [ ] T2.7. C2 commit + 全测试通过

## Phase 3 — C3 dialogs

- [ ] T3.1. `feedback-dialog.tsx` 用 DialogBase 重写
- [ ] T3.2. `new-session-dialog.tsx` 用 DialogBase 重写（target 432 →
  ~250 LOC）
- [ ] T3.3. `quota-panel.tsx` 用 DialogBase / Sheet（按 DP5 决策）重写
- [ ] T3.4. `toolbar-edit-dialog.tsx` 内容暂保留（C4 拆到 /settings 时再
  分解，此 commit 仅 visual rewrite）
- [ ] T3.5. autoFocus 系统化审核（B8）：所有 dialog 显式声明 autoFocus
  规则，记录在 DialogBase props 文档
- [ ] T3.6. 浏览器验所有 dialog（open / close / submit / mobile tap）
- [ ] T3.7. C3 commit + healthz

## Phase 4 — C4 pages part 1（login + settings）

- [ ] T4.1. `login.tsx` Warp 风重写
- [ ] T4.2. `pages/settings.tsx` 新建（按 DP6 决策路由形态）
- [ ] T4.3. settings 内容：从 toolbar-edit-dialog 拆出 toolbar config
  + theme toggle + （未来）quota / diag 入口
- [ ] T4.4. `app.tsx` 加 /settings 路由
- [ ] T4.5. 删 toolbar-edit-dialog 入口（mobile-toolbar 改链接到
  /settings）
- [ ] T4.6. 浏览器验 login / settings
- [ ] T4.7. C4 commit + healthz

## Phase 5 — C5 pages part 2（workspace + B1）

- [ ] T5.1. `workspace.tsx` Warp 风重写（session list / status bar /
  toolbar 等）
- [ ] T5.2. `session-list.tsx` 用 ListBase + StatusBadge 重写
- [ ] T5.3. B1 stale session id URL UX：`/workspace/<S>` 中 S 不在
  sessions list 时显示 friendly banner + "回 /" 按钮
- [ ] T5.4. `mobile-toolbar.tsx` 重写
- [ ] T5.5. `notification-banner.tsx` 重写
- [ ] T5.6. `theme-toggle.tsx` 重写（segmented control）
- [ ] T5.7. 浏览器验 workspace（含 stale URL 场景 / mobile / desktop）
- [ ] T5.8. C5 commit + healthz

## Phase 6 — C6 cleanup

- [ ] T6.1. 删 `web/src/styles/app.css`
- [ ] T6.2. 删 `web/src/styles/themes.css`
- [ ] T6.3. 删 `web/src/styles/reset.css`
- [ ] T6.4. 删 `web/src/components/selectable-list.tsx`
- [ ] T6.5. grep 验：无 `from '@radix-ui/react-dialog'` 直接 import（除
  DialogBase 内部）
- [ ] T6.6. grep 验：无硬编码 SessionState 颜色判断
- [ ] T6.7. 全 page 浏览器二次验（login / workspace / settings / 各
  dialog / dark 与 light mode 切换 / mobile + desktop）
- [ ] T6.8. C6 commit + healthz
- [ ] T6.9. 跑 `pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm
  test`

## Phase 7 — Ship

- [ ] T7.1. 整理大 PR 描述（含审美锚定 / 决策摘要 / 6 commit 概览）
- [ ] T7.2. 用户最终 review + 授权
- [ ] T7.3. archive：`mv openspec/changes/m-design-system-unify
  openspec/archive/<date>-m-design-system-unify`
- [ ] T7.4. `openspec/BACKLOG.md` 删除 B1 / B4 / B8 三条
- [ ] T7.5. 同步 spec delta（涉及 area：web-ui / workspace / settings）
- [ ] T7.6. tasks.md 回填各 phase 的 commit hash
