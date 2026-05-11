---
status: planned
---

# Proposal: m-design-system-unify — 全 web 端视觉风格统一（Warp settings 锚定）

## 状态

planned。审计触发：用户指出当前 UI "硬拼"——`app.css` 1388 行 / 117
class / 9 段独立 section，每个 page 与 dialog 各自写一套，0 第三方 UI
库，9 个颜色 token 之外无 spacing / radius / shadow / typography scale。

## Intent

把 ccanywhere web 端的视觉系统从"手写 CSS + 各 page 各搞各的"升级为：

1. **统一 design system**：shadcn/ui 作组件骨架 + tailwind 作 utility/tokens
   层，配色 / spacing / radius / shadow / font scale 全 token 化。
2. **审美锚定 Warp settings GUI 风**（dark first 工程师审美 / 字体 sans+mono
   分工 / 4-6px 圆角 / 几乎无 shadow / 紧凑 padding）。否决：SaaS dashboard
   范式（shadcn 默认调性）/ TUI charm.sh 范式（ASCII box-drawing）/ Material
   / 企业后台风。
3. **按 8 类数据模型驱动 UI surface 重组**（Session / User / Theme /
   Prefs / Diag / OpsLog / Quota / Feedback）。

## 决策摘要

D1. **库选型 = shadcn/ui + tailwind**。理由：shadcn 组件代码 copy 进
    repo 完全可改、底层 Radix 提供 a11y/键盘、tailwind 提供完整 tokens
    体系。与用户 `feedback_prefer_libs.md` 偏好对齐。

D2. **美学定锚 = Warp settings GUI 风**。
    - 不是 SaaS dashboard（圆角大、留白多、阴影深、卡片多）
    - 不是真 TUI（box-drawing、bracket prompt、monospace 全局）
    - 是"现代工程师 web GUI"：dark first、紧凑、扁平、字体分工

D3. **字体硬规则（最强视觉锚）**：
    - UI label / 提示 / 按钮文案 = sans-serif（`-apple-system, Inter`）
    - **所有数据值** = monospace（`SF Mono, JetBrains Mono`）：
      session id / token / path / shortcut key（`⌘+K`）/ state
      label（`idle` `busy`）/ count / timestamp

D4. **token scale 上限**：
    - radius ≤ 6px（封顶；不接受 8 / 12 / 16px）
    - shadow 仅 dialog overlay 一处使用（其余 0）
    - 配色 = 5 中性（bg / bg-elevated / border / fg / fg-muted）+ 3
      status（success / warning / danger）+ 1 brand = 9 色封顶
    - 命名对齐 shadcn 习惯：`brand` = 突出强调色（primary button bg
      / focus outline），`accent` 让位给 shadcn 的 hover-bg 语义（=
      `var(--bg-elevated)`，不是独立颜色）

D5. **dialog 系统统一**：所有 4 个 dialog（feedback / new-session /
    toolbar-edit / quota-panel）共用同一 `<Dialog>` 抽象（Radix Dialog
    包装一层），不再各写 overlay / container / header / close button。

D6. **list 系统统一**：selectable-list + session-list 合并到统一
    `<List>` 抽象。**紧凑 list view**（一行一 entry），不是 card grid。

D7. **StatusBadge 统一组件**：SessionState 4 状态（starting / idle /
    busy / dead）显式映射到 token。**monospace 文字**（`idle`），不是
    colored pill。

D8. **store 改动**：拆 `state/sessions.ts` 为 `state/projects.ts` +
    `state/sessions.ts`。其它 6 store（auth / diag / ops-log / prefs /
    ui + hooks）不动。

D9. **节奏**：内部 5-6 个 commit（每 commit 部署 + healthz 验证），最终
    一次性大 PR。用户坚持一次性 PR；我已提示 review/rollback 风险并被接受。

D10. **搭车 BACKLOG**：合并 B1（stale session URL UX）/ B4（/settings
     独立 page）/ B8（dialog autoFocus 系统化审核）。这三条本身就和本项
     视觉重写强耦合，分开做会重复劳动。

## 落地点

**新增**：
- `web/tailwind.config.ts` — tailwind 配置（含 token 注入）
- `web/postcss.config.cjs` — postcss + tailwind plugin
- `web/src/styles/tokens.css` — design tokens（color / spacing / radius
  / shadow / fonts / z-index）
- `web/src/components/ui/` — shadcn 复制的 base 组件目录
  （button / input / dialog / sheet / tabs / dropdown-menu / toast / badge
  / select / switch / separator 等）
- `web/src/components/dialog-base.tsx` — ccanywhere 自包装 Dialog（统一
  header / close / footer pattern）
- `web/src/components/list-base.tsx` — 统一 List 抽象
- `web/src/components/status-badge.tsx` — SessionState 状态映射
- `web/src/pages/settings.tsx` — 新 /settings page（B4）
- `web/src/state/projects.ts` — 拆出的 projects store

**改写**：
- `web/package.json` — 加 `tailwindcss` / `@tailwindcss/postcss` /
  `tailwindcss-animate` / `class-variance-authority` / `clsx` /
  `tailwind-merge` / `lucide-react` / `@radix-ui/*` 必要 primitive
- `web/src/main.tsx` — import tokens.css + 全局 font
- `web/src/app.tsx` — 加 /settings 路由
- `web/src/pages/login.tsx` — Warp 风重写
- `web/src/pages/workspace.tsx` — 重写 + B1 stale session 处理
- `web/src/components/feedback-dialog.tsx` — 用 `<DialogBase>`
- `web/src/components/new-session-dialog.tsx` — 用 `<DialogBase>`（最大
  瘦身 target：432 LOC → ~250 LOC）
- `web/src/components/toolbar-edit-dialog.tsx` — 拆为 /settings page 一
  个 section（B4）
- `web/src/components/quota-panel.tsx` — 用 `<DialogBase>`
- `web/src/components/session-list.tsx` — 用 `<ListBase>` + StatusBadge
- `web/src/components/selectable-list.tsx` — 删（被 ListBase 取代）
- `web/src/components/mobile-toolbar.tsx` — Warp 风重写
- `web/src/components/notification-banner.tsx` — 重写
- `web/src/components/theme-toggle.tsx` — 重写（segmented control）
- `web/src/state/sessions.ts` — 拆 projects 部分到新 store

**删**：
- `web/src/styles/app.css` — 1388 行全删
- `web/src/styles/themes.css` — 23 行，迁移到 tokens.css 后删
- `web/src/styles/reset.css` — 由 tailwind preflight + tokens.css 替代

## 形式化保证

F1. 全局字体分工：UI chrome = sans-serif；所有数据值 = monospace。无
    例外。Lint 不强制（CSS class 是判断难自动），靠 review。

F2. radius ≤ 6px。tokens.css 只暴露 `--radius-sm: 2px` / `--radius-md:
    4px` / `--radius-lg: 6px`，没有更大。

F3. shadow tokens 只暴露 `--shadow-dialog`，其它组件不用 shadow。

F4. 配色封顶 9 色（5 中性 + 3 status + 1 brand）。tokens.css 不暴露
    其它颜色变量。shadcn 期望的 `--color-background` `--color-primary`
    等 18 个名称仅作技术层 alias 指向上述 9 色，不引入新色相。

F5. 所有 dialog 通过 `<DialogBase>` 创建。grep 不应有任何组件直接 import
    `@radix-ui/react-dialog`。

F6. 所有 list 通过 `<ListBase>` 创建。

F7. SessionState 状态显示通过 `<StatusBadge>`。grep 不应有任何组件硬
    编码 `state === 'busy'` 直接渲染颜色。

F8. `sessions store` 拆分后**对外 hook API 不变**（仍有
    `useSessionsStore` 入口），只是内部数据组织拆开。调用方不需要全改。

## 不做项

- 不动 server / api / cli 端任何代码
- 不动 store 公开接口（拆 sessions 仅内部重组，hook 入口保留）
- 不动 xterm.js terminal 渲染（仅 chrome）
- 不引 CSS-in-JS（vanilla-extract / Panda / Emotion）
- 不引黑盒 UI 库（Mantine / antd / Chakra / MUI）
- 不深度做 light mode（dark first，light 保持可用即可，不像素级优化）
- 不做 i18n（继续中文 hardcode）
- 不全审 a11y screen-reader（依赖 Radix 默认即足）
- 不做 motion / animation 系统（个别动画用 `tailwindcss-animate`）
- 不做 keyboard hint footer / status line（TUI 风元素，与 D2 锚定冲突）

## 范围估算

| 模块 | LOC delta（不算 shadcn 自动生成） |
|---|---|
| A. infra（tailwind / tokens / shadcn 引入 / 自包装 3 抽象） | +~280 |
| B. 4 dialog 重写 + autoFocus 审核 (B8) | +~400 |
| C. login + workspace 重写 + B1 stale session | +~400 |
| D. /settings page 新建 (B4) | +~250 |
| E. list / badge / toolbar / banner / theme-toggle | +~150 |
| F. store 拆分 | +~150 |
| G. CSS 全删 | -~1450 |
| **净 delta** | **~+180** |
| **总改动量** | **~3000 LOC**（不含 shadcn 自动生成 ~600 LOC） |

## Commit 边界（内部 5-6 笔 → 最终一次性大 PR）

| # | scope | 验证 |
|---|---|---|
| C1 | infra：tailwind + postcss + tokens.css + shadcn copy 8 base + 全局 reset | typecheck / lint / build / healthz |
| C2 | abstractions：DialogBase / ListBase / StatusBadge + projects store 拆分 + 单元测试 | typecheck / 单元测试 / healthz |
| C3 | dialogs：4 dialog 用 DialogBase 重写 + autoFocus 审核 (B8) | typecheck / 浏览器验 / healthz |
| C4 | pages part 1：login + /settings page (B4) | 浏览器验 login / settings / healthz |
| C5 | pages part 2：workspace 重写 + B1 stale session UX | 浏览器验 workspace / stale URL / healthz |
| C6 | cleanup：删 app.css / themes.css / reset.css / selectable-list / 全 page 二次验 | typecheck / lint / 浏览器全表验 / healthz |

## 决策点（已定 — 用户 "全部默认先"）

DP1. **monospace 字体 = 系统 `ui-monospace, SF Mono, Menlo,
     "JetBrains Mono", Consolas, monospace`**。不引 npm webfont，bundle
     最小、首屏无 webfont swap 抖动。

DP2. **sans 字体 = 系统 `-apple-system, BlinkMacSystemFont, "Segoe UI",
     system-ui, sans-serif`**。同 DP1 理由。

DP3. **brand 色 = `#6b7cff`**（克制冷蓝紫；dark mode 锚色）；light mode
     稍调深为 `#4a5cde` 保证对比度。注：原方案叫 "accent"，落地时为对
     齐 shadcn 命名习惯改名 "brand"；shadcn 的 `accent` 是 hover/active
     背景语义，已在 tokens 里 alias 到 bg-elevated。

DP4. **light mode = 认真做**。不仅 dark 反色 fallback；token scale 双
     色板独立维护。代价：tokens.css 量翻倍但仍在 ~120 LOC 预算内。

DP5. **quota panel 保 dialog**（不改 Sheet）。当前已是 dialog 形态，
     用户习惯不变。

DP6. **/settings 独立 page** at `/settings`。理由：
     - 偏好项未来会扩（B4 早就预留）
     - mobile 上 dialog 太挤
     - 独立 page chrome（header + back button）支持深层 setting tab

DP7. **status badge = 纯 monospace 文字** (`idle` / `busy` / `starting`
     / `dead`)。颜色由文字本身的 fg color 表达（busy = warning fg /
     dead = danger fg / idle = fg-muted / starting = brand）。无圆点
     无方括号无背景 pill。

DP8. **dialog autoFocus 按 dialog 显式声明**。DialogBase 默认 `autoFocus
     = undefined`（无 autoFocus）；个别 dialog 显式声明 `autoFocus
     = { input: 'token-input' }` 之类。grep 即可全审。

## 关联

- 出处：本次 conversation 审计
- 搭车 BACKLOG B1 / B4 / B8（ship 时这三条从 BACKLOG.md 删除）
- 不影响：m-share-static-export（独立路径）/ m-fit-cols-off-by-one /
  m-touch-scroll-one-line（仍 blocked-on-data，与本项无关）
- 阻塞：m-toolbar-presets（依赖 /settings page 重写完成，应该在本项 ship
  之后）

## 反向风险评估

- 一次性大 PR review 难、rollback 难（用户已确认接受）
- shadcn copy 进 repo 后维护责任在我方（不再 npm 升级，但小 surface area
  实际反而省心）
- tailwind 引入是一次性增重（dev dep + build pipeline）；prod bundle
  增量小（purge 后），但 build 时间会增长 1-2 秒
- store 拆分 = 调用方需要同步改；通过保持 hook 入口 API 不变降低冲击
- 1388 行 CSS 全删 = 视觉退化风险；通过内部 6 commit + 每笔 healthz
  + 浏览器验缓解
