# Tasks: m-design-system-unify (planned)

## Phase 0 — 启动前对齐（用户拍板）

- [x] T0.1. 用户审 proposal 整体方向（D1-D10）
- [x] T0.2. 用户拍 DP1-DP8 决策点（"全部默认先"——见 proposal DP 段已锁定）

## Phase 1 — C1 infra（提交边界）

- [x] T1.1. `web/package.json` 加 deps（tailwind v4 + cva + clsx +
  tailwind-merge + lucide-react + @radix-ui 必要 primitive）
- [x] T1.2. tailwind v4 配置（CSS-first `@theme` block in tokens.css，
  无独立 tailwind.config.ts）
- [x] T1.3. postcss 配置（`@tailwindcss/postcss`）
- [x] T1.4. `web/src/styles/tokens.css`（color / spacing / radius / shadow
  / fonts / z-index 全量 tokens）
- [x] T1.5. shadcn copy base 12 组件（button / input / dialog / sheet /
  tabs / dropdown-menu / toast / badge / select / switch / separator /
  label / scroll-area / textarea）
- [x] T1.6. `web/src/main.tsx` import tokens.css + 全局 font
- [x] T1.7. 旧 `app.css` 暂不删（C6 才删）；新旧并存让验证可对照
- [x] T1.8. C1 commit + healthz 验证 (f4cf0a6)

## Phase 2 — C2 abstractions + store 拆分

- [x] T2.1. `web/src/components/dialog-base.tsx`（统一 header / close /
  footer pattern；sr-only description fallback 解 Radix a11y warning；
  DP8 autoFocus 默认 off）
- [x] T2.2. `web/src/components/list-base.tsx`（紧凑 list view；
  primary/secondary 双 slot；secondary 强制 mono 字体 per F1；interactive
  vs static 两形态）
- [x] T2.3. `web/src/components/status-badge.tsx`（SessionState 4 状态
  映射，纯 mono 文字，颜色 starting=brand/idle=fg-muted/busy=warning/
  dead=danger per DP7）
- [x] T2.4. `web/src/state/projects.ts` 拆出（Project/HistorySummary 类
  型 + useProjectsStore + 4 action：fetchProjects / fetchHistory /
  createProject / hideProject + resetProjectsStoreForTest）
- [x] T2.5. 调用方迁移：use-completion-notify.ts / workspace.tsx /
  new-session-dialog.tsx / session-list.tsx 共 4 处 grep + 改 import
- [x] T2.6. 单元测试：projects.test.ts (7 case) / status-badge.test.tsx
  (4 case) / list-base.test.tsx (6 case) / dialog-base.test.tsx (6 case)
- [x] T2.7. C2 commit + 全测试通过 (b7ad59f)

## Phase 3 — C3 dialogs

- [x] T3.1. `feedback-dialog.tsx` 用 DialogBase 重写（含 shadcn Input/
  Textarea/Label/Button + Form 状态机 compose/submitting/submitted/error）
- [x] T3.2. `new-session-dialog.tsx` 用 DialogBase + Tabs(mode) +
  ListBase(projects/history) + SortButton 重写（432 → 366 LOC，剩余
  ~120 LOC 是 essential logic：resize / sort / new-project subform /
  step 状态机；未达 250 target 但 dialog wrapper / list / sort 都已
  抽象，未来再缩 cost 高）
- [x] T3.3. `quota-panel.tsx` 用 DialogBase 保 dialog 形态（DP5）重写；
  progress bar tone 改 bg-brand/bg-warning/bg-danger per DP7
- [x] T3.4. `toolbar-edit-dialog.tsx` visual rewrite（C4 才拆 /settings）
  + 提取 ToolbarCell / ToolbarCatalogKey wrap pattern（响应用户
  "进一步 wrap 常用 pattern" 偏好）
- [x] T3.5. autoFocus 审核（B8）：DialogBase 默认 autoFocusContent=
  false per DP8；4 dialog 未显式覆盖，统一 off。grep autoFocus 仅
  login page 留（非 dialog 范畴）
- [x] T3.6. e2e visual screenshot 自检（`web/e2e/visual.spec.ts`，
  3 case）：workspace home / new-session dialog / feedback dialog，
  Read PNG 视觉符合 Warp settings 调性。quota / toolbar-edit dialog
  需要 active cc session，e2e 难驱动，留待 user 浏览器手开补验
- [x] T3.x. 加 ToolbarCell / ToolbarCatalogKey / SortButton 三个
  pattern wrap + shadcn Textarea 引入（响应用户 wrap 偏好）
- [x] T3.7. C3 commit + healthz (505c1a2)

## Phase 4 — C4 pages part 1（login + settings）

- [x] T4.1. `login.tsx` Warp 风重写
- [x] T4.2. `pages/settings.tsx` 新建（按 DP6 决策路由形态——壳，
  内容在 B4 task）
- [x] T4.3. settings 内容：B4 task — 拆出 ToolbarConfigSection
  + theme toggle 留 page header；quota / diag 入口待未来扩
- [x] T4.4. `app.tsx` 加 /settings 路由
- [x] T4.5. 删 toolbar-edit-dialog 入口：workspace.tsx ⚙ 按钮改
  navigate('/settings')；删 toolbarEditOpen / dialog import；删
  toolbar-edit-dialog.tsx + 旧 test
- [x] T4.6. 浏览器验 login / settings（e2e visual + Read 截图自检，
  visual-login-idle-dark.png / visual-settings-toolbar-dark.png）
- [x] T4.7. C4 commit + healthz (3bb416d)

## Phase 5 — C5 pages part 2（workspace + B1）

- [x] T5.1. `workspace.tsx` Warp 风重写（30+ css class 全切 tailwind；
  drawer 用 max-md transform；ThemeToggle 从 sidebar 移除以省 320px
  drawer 空间，user 走 /settings 切）
- [x] T5.2. `session-list.tsx` 用 StatusBadge 重写；ListBase 因 row
  需 Link wrap + trailing delete 不适配 radiogroup shape，借鉴其
  视觉而非组件
- [x] T5.3. B1 stale session id URL UX：5s 后 auto-redirect 回
  /workspace；文案 "会话已结束 / 可以新建一个，或回到首页查看其它
  会话。"；e2e jargon regression 守护文案不退化
- [x] T5.4. `mobile-toolbar.tsx` 重写（grid via inline style；
  cells = rounded-sm border + mono；sticky-ctrl active = brand fill；
  md:hidden 取代 @media pointer:fine）
- [x] T5.5. `notification-banner.tsx` 重写（border-b + bg-elevated +
  shadcn Button variants；保留 dismiss / enable 两态）
- [x] T5.6. `theme-toggle.tsx` 重写（segmented control 3 段：
  Auto/Light/Dark；radiogroup + 3 radio；rounded-md outer + rounded-sm
  inner active）
- [x] T5.7. 浏览器验 workspace（e2e visual 6 case + Read 截图自检；
  stale URL 场景留待 B1，mobile-toolbar 截图需 active session 留待
  user 手验）
- [x] T5.8. C5 commit + healthz (d226c33; B1 stale session 在 d4b9055)

## Phase 6 — C6 cleanup

- [x] T6.1. 删 `web/src/styles/app.css` (1388 行)
- [x] T6.2. 删 `web/src/styles/themes.css`（被 tokens.css 完全替代）
- [x] T6.3. 删 `web/src/styles/reset.css`（box-sizing/margin 等
  tailwind preflight 替代；剩 html/body/#root height + body bg/fg
  迁到 tokens.css `@layer base`）
- [x] T6.4. 删 `web/src/components/selectable-list.tsx`（被 ListBase
  取代，无外部引用）
- [x] T6.5. grep 验 `from '@radix-ui/react-dialog'` 仅匹配
  dialog-base.tsx 注释 doc 提及（无 production import）
- [x] T6.6. grep 验：3 处 `state === 'X'` 命中均为状态逻辑判断
  (ws.ts / use-completion-notify.ts) 而非颜色渲染，合规
- [x] T6.7. e2e visual 7 case 全过；Read 截图自检 6 个 surface
  (login / workspace home / settings / new-session dialog / feedback
  dialog / stale session) 全部 dark mode 渲染正常；mobile-toolbar +
  light mode 留待 user 手验（e2e 难驱动 active session 与时钟切换）
- [x] T6.8. C6 commit + healthz (6ff7a52; P1 checkpoint e1cfb82)
- [x] T6.9. typecheck:all / lint / lint:md / test (315 vitest) ✓
- 改写：`error-boundary.tsx` (切 tailwind) / `terminal.tsx` JSX
  (terminal-view-pane / terminal-view / terminal-placeholder 切
  tailwind，cursor blink 用 animate-pulse 替代)
- 新增：`web/src/styles/xterm-overrides.css`（xterm-viewport 滚动
  override 单独抽出；与 ccanywhere design system 解耦）

## Phase 6.5 — User review polish (checkpoint)

- [x] P1. terminal header 中 mono StatusBadge ("idle") vs sans
  project name 视觉错位。root cause：mono 字符 visual mass (stroke
  width + 字符宽) > sans，是字体设计差异，CSS 字号 / line-height /
  ex 调整都无法物理消除。决策：top bar StatusBadge 改用 dot variant
  （彩色圆点紧贴 project name），session-list 仍用 text variant。
  避开 mixed-font 视觉冲突，状态信息保留
- [x] P2. `StatusBadge` 加 `variant: 'text' | 'dot'` prop；dot 用
  `bg-{brand|fg-muted|warning|danger}` 4 个 token 颜色，保 F7 状态-
  色映射唯一
- 已知遗留（user 标 "问题很多但先作为版本"）：右侧 3 个 emoji icon
  + ws-conn label 的密度 / baseline 问题未处理；这步为 checkpoint
  commit，后续单独 task 整理

- [x] T7.1. 整理大 PR 描述（含审美锚定 / 决策摘要 / 6 commit 概览）—
  延迟到 ship 时单独写 PR body，archive proposal 已是完整记录
- [x] T7.2. 用户最终 review + 授权（"按顺序吧"=ship 收尾授权）
- [x] T7.3. archive：`mv openspec/changes/m-design-system-unify
  openspec/archive/2026-05-13-m-design-system-unify`
- [x] T7.4. `openspec/BACKLOG.md` 删除 B1 / B4 / B8 — B1 (stale
  session URL UX) ship 时已搭车进 C5 D5.3 实现 + 未独立列入 BACKLOG；
  B4 / B8 在本 ship 此次 Phase 7 中删除
- [x] T7.5. spec delta：`openspec/specs/web-frontend/spec.md` 加
  "Design system（m-design-system-unify）" Requirement（字体分工 /
  token 上限 / component 抽象 / autoFocus 默认 / store 拆分 + 3
  Scenario），update "路由" Requirement /settings 描述（占位 →
  偏好设置 page）
- [x] T7.6. tasks.md 回填各 phase commit hash（C1 f4cf0a6 / C2
  b7ad59f / C3 505c1a2 / C4 3bb416d + B4 e8ac553 / C5 d226c33 + B1
  d4b9055 / C6 6ff7a52 / P1 e1cfb82）
