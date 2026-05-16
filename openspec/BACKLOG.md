# Backlog（轻量级未启动 task 索引）

集中维护**小项**（≤80 LOC，单笔可做完）。大项各自有 `openspec/changes/
<slug>/`。已 ship 全部进 `openspec/archive/<date>-<slug>/`。

新决策出现新 backlog 项时立即在这里 append（不要靠"我记"）。

启动某项时把它从这里删，转到 `openspec/changes/<slug>/`（即便很小也建
proposal，统一流程）。

---

## 真实 bug（fix 类）

（无）

---

## 体验增强 / polish

### B28. share view sticky header mobile 滚动 shrink padding

- **scope**：~30 LOC
- **优先级**：低
- **背景**：m-share-header-sticky ship 后 sticky bar `padding: 12px
  56px 16px 0` mobile 占首屏 ~12vh。
- **方案**：IntersectionObserver sentinel 在 sticky bar 后插一个 1px
  div，sentinel 离开 viewport 时给 header 加 `.shrunk` class →
  padding 缩成 `padding: 4px 56px 6px 0`。
- **出处**：2026-05-17 subagent 评审 1 (BACKLOG 候选 4)

### B30. workspace mobile drawer 切 `ui/sheet.tsx`（删手写 transform + backdrop）

- **scope**：~60 LOC
- **优先级**：**高**（最大 reinvent-wheel，自动得到 focus trap / Escape / aria-modal / 动画）
- **背景**：`workspace.tsx` 手写 `max-md:fixed inset-y-0 transform translate-x-*` drawer + `<button class="fixed inset-0 bg-black/50">` backdrop 模拟 modal。`ui/sheet.tsx` 已 import 但仅 `mobile-toolbar.tsx` 用到（toolbar-edit），workspace 主 drawer 没复用。
- **方案**：把 workspace.tsx aside 改 `<Sheet open={drawerOpen} onOpenChange={setDrawerOpen} side="left">` + `<SheetContent>`。删手写 transform + backdrop button + drawerOpen state machine 大段。
- **出处**：2026-05-17 subagent 评审 2 §3

### B31. mobile toolbar + drawer 加 `env(safe-area-inset-*)`

- **scope**：~15 LOC
- **优先级**：**高**（iPhone 横屏 / 全面屏 PWA 模式 swipe bar 区域占）
- **背景**：mobile-toolbar.tsx 和 workspace drawer 没 safe-area，iPhone 横屏底部 swipe bar 覆盖 toolbar 行，PWA 全屏更严重。
- **方案**：mobile-toolbar 容器加 `pb-[env(safe-area-inset-bottom)]`；workspace drawer 加 `pl-[env(safe-area-inset-left)]`；全站 search 一遍 fixed bottom 元素。
- **出处**：2026-05-17 subagent 评审 2 §3

### B32. UI state primitives 三件套（EmptyState / ErrorState / Skeleton）

- **scope**：~120 LOC（**建议建 changes/m-ui-state-primitives 大项**）
- **优先级**：中
- **背景**：empty-pane.tsx 只 26 行且 drawer-trigger 写死耦合 workspace。list-base.tsx 自带 emptyLabel、各 dialog 内 `加载中…` `加载失败` 手写、my-shares-section 同。无 skeleton（首屏空白感知慢）。
- **方案**：建 `components/ui-state/` 三件套——`<EmptyState icon title description action />`、`<ErrorState error retry />`、`<Skeleton variant="list-row" count={5} />`。替换 ~6 处散落点。
- **出处**：2026-05-17 subagent 评审 2 §7

### B33. server state 切 TanStack Query（新功能起 query，旧渐进迁）

- **scope**：~200 LOC（**建议建 changes/m-server-state-tanstack-query 大项**）
- **优先级**：中
- **背景**：9 颗 zustand store 把 fetch + cache + error 揉一起，`use-background-poll.ts` 手写 polling，`sessions.ts` 手写乐观更新——TanStack Query 一行 hook 解决。当前 scale 撑得住但新功能（quota / shares / feedback list）继续加 store 会增维护负担。
- **方案**：先 install + wrap `<QueryClientProvider>`；新功能（quota panel / shares list）直接用 `useQuery`；旧功能（sessions / projects）保留 zustand 不强迁；删 use-background-poll 改 `refetchInterval`。
- **出处**：2026-05-17 subagent 评审 2 §4

### B34. Unicode glyph → lucide icon（5 处 ☰ / × / ↑↓）

- **scope**：~25 LOC
- **优先级**：低
- **背景**：empty-pane.tsx 和 workspace-main-pane.tsx 的 `☰`、session-list.tsx 和 notification-banner.tsx 的 `×`、sort-button.tsx 的 `↑↓` 用 Unicode 字符——渲染权重不可控、对齐 baseline 不一致、aria 友好度差。
- **方案**：替换为 lucide-react 对应 icon（`Menu / X / ArrowUp / ArrowDown`）。机械替换。
- **出处**：2026-05-17 subagent 评审 2 §5

### B35. xterm theme hex 抽到 tokens.css `@theme` 暴露给 xterm 初始化

- **scope**：~25 LOC
- **优先级**：低
- **背景**：`terminal-config.ts:34-43` 散落 8 个 xterm hex（webgl canvas 不读 CSS var 有合理理由）。
- **方案**：tokens.css `@theme` 块加 `--color-xterm-*` raw value（不 alias），terminal-config.ts 改读 `getComputedStyle(document.documentElement).getPropertyValue('--color-xterm-*')`。
- **出处**：2026-05-17 subagent 评审 2 §1

### B36. `components/` 平铺切 feature 子目录（触发阈：50 文件）

- **scope**：~40 LOC（纯 import path 移动）
- **优先级**：低
- **触发信号**：`components/` 突破 50 文件（当前 33）
- **背景**：composition 平铺到 33 个文件，还撑得住；到 50+ 难找。
- **方案**：建 `components/workspace/ / session/ / auth/ / feedback/` feature 子目录，原文件按 feature 归类。grep 全 import path 改一遍。
- **出处**：2026-05-17 subagent 评审 2 §2

### B37. React 18.3 → 19、Vite 5.4 → 6 dep bump

- **scope**：~50 LOC（package.json bump + 跑全套 e2e 回归）
- **优先级**：低（稳定优先于追新）
- **背景**：React 19 已 stable 一年；Vite 6 也已 stable；Tailwind 4 已同步。useTransition / Suspense API 行为差异需要回归 xterm.js / radix。
- **方案**：bump deps + 跑 root test + web test + e2e 全套。
- **出处**：2026-05-17 subagent 评审 2 §8

### B21. share 页面快速导航：滑动条 + 目录 + 回到顶部

- **状态**：待商榷（user 2026-05-16 标 "第二个有待商榷"）—— 启动前必须先 brainstorm 收敛
- **scope**：~unknown，依方案而定（独立讨论）
- **背景**：share 页对话很长（数百到数千行）时缺乏快速导航手段。当前
  只能浏览器滚动条 + cmd-F 搜索。
- **方案候选（待 user 决策）**：
  - **a. 浮动 "回到顶部" 按钮**（最小）：右下角浮动 `↑`，scroll > N
    时 fade-in；点击 scrollTo({top: 0, behavior: 'smooth'})。~30 LOC
  - **b. 快速滑动条**（中）：右侧固定 mini-scrollbar 显示文档进度 +
    drag 跳跃，类似 vscode minimap。~80-120 LOC
  - **c. 目录导航**（大）：解析对话结构（user / assistant turn 分段）
    生成 TOC sidebar，点击跳到对应 turn。~150-200 LOC，需要 share
    导出时保留 turn 结构标记
- **决策点**：a 是最小快赢，b 是体验中等增量，c 改 share export 格式
  影响范围大。是 a / b / c 单做 还是组合
- **出处**：2026-05-16 user dogfood

（原小项已清空，B19 archive abandoned + B14/16/18 ship + 上批 #2 ship）

---

## E2E / CI

（无）

---

## 维护类 / 不做但记录

---

## Deferred（触发条件未到 — 等真实信号再启动）

下面这些条目都已有完整 scope + 决策点 + 出处。但触发条件（user 实际抱怨
/ 量级达到痛阈值）尚未到，启动是浪费。本段是"显式 deferred 而非遗忘"
的可见队列——下次扫 BACKLOG 看到这段就跳过，除非有新信号。

### B12. Level 2 scrollback 持久化

- **状态**：deferred（"最后一屏已能定位上下文"基线尚未被 user 抱怨突破）
- **触发信号**：user 进 dead pane 抱怨"想看历史滚动找不到"
- **scope**：~150 LOC（dead 时 scrollback 全文 → 单独 file；resume 时 feed
  回 xterm 还原；存储格式与 screen.txt 共享路径）
- **背景**：m-session-persistence Level 1 只持久化"最后一屏"（含 ANSI
  alt-screen + cursor 位置），dead pane 看不到历史滚动。Level 2 把
  scrollback ring buffer 全文落盘，user 进 dead session 能滚回看历史
- **决策点**：scrollback 大小（默认 1024 行 ~50-200 KB）/ format
  （raw ANSI 还是 plain text）/ 是否压缩
- **出处**：m-session-persistence proposal D8 "不做" 段标记 follow-up

### B17. login.tsx useLoginMode state machine hook

- **状态**：deferred（触发条件未到）
- **scope**：~60 LOC（抽 `useLoginMode()` hook 集中 8-kind Mode
  discriminated union 状态机）
- **背景**：`web/src/pages/login.tsx:20-29` 定义 8 kind Mode union，
  `:42` setMode 在 11 处直接调用。已经把 IdleChoices 拆出来了（说明
  作者愿意拆）。下次加新 mode（如 SSO / OAuth）时顺手抽。
- **触发信号**：第三种登录方式被引入（当前仅 webauthn + token）
- **出处**：本评审 B2

### B13. dead session retention policy

- **状态**：deferred（单 owner + ~10 limited e2e user，dead 数量远未到累积痛阈值）
- **触发信号**：boot 扫 sessions/ 慢 / 占盘超过痛阈值 / share 功能 ship 后 multi-user 累积
- **scope**：~80 LOC + config schema bump
- **背景**：m-session-persistence D11 决定 dead session 无自动 GC——user
  不主动删就永远留。长期 N 大用户会累积 N 个 `<id>.json` + `.screen.txt`
  慢 boot 扫描 + 占盘。可选 retention：超 N 天 / total size 超 M MB
  时按 LRU hard delete dead stub
- **决策点**：默认 ttl（7d / 30d / 永不）/ 是否进 config schema /
  loadDeadStubs 时机做不做 size-based prune
- **风险**：config schema bump = prod 同步成本（参考 m-multi-user
  `guestProjectsRoot` 教训）
- **出处**：m-session-persistence proposal D11 + "不做" 段

---

## 大项（在 `openspec/changes/<slug>/`，本表只列出处指针）

- **m-toolbar-presets**（~80 LOC）— 内置 toolbar 模板 + swap。
  决策点未定（preset 数量 / 自定义保存）。`changes/m-toolbar-presets/`
- **m-touch-scroll-one-line**（~50 LOC，blocked-on-data）— 偶发滑动一行
  bug。`changes/m-touch-scroll-one-line/`
- **m-fit-cols-off-by-one**（in-flight，blocked-on-data）— Phase 1 trace
  已 ship；等用户反馈触发 Phase 2/3。`changes/m-fit-cols-off-by-one/`
