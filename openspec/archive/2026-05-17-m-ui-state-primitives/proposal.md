---
status: in-flight
---

# Proposal: m-ui-state-primitives — EmptyState / ErrorState / LoadingState / Skeleton

## Intent

BACKLOG B32（subagent 评审 2 §7）：empty / error / loading state 在 7 处
散落手写文案，无统一组件 / 无 skeleton。当前：

- workspace-main-pane: `<p>加载中…</p>` 纯文本
- my-shares-section: 3 处 `加载中… / 加载失败 / 还没有分享`
- quota-panel: `加载失败：...`
- session-list: `还没有会话。点击「+ 新建」创建一个。`
- new-session-step1-picker: `还没有项目...`
- list-base: `emptyLabel` prop default '空'

加 4 个 ui-state primitives 统一这些状态视觉 + 文案风格 + 无障碍角色。

## 决策

### D1. 4 个组件而非 3 个

subagent 评审建议 3 件套（Empty / Error / Skeleton），加 Loading 是因为
loading state 与 skeleton 不等价 — loading 是 "等待中无内容显示" 简单
文本/spinner，skeleton 是 "占位骨架替代真实 layout"。两者用例不同：
- 简短 fetch（quota / shares list）→ LoadingState
- 列表首屏（session list 启动时）→ Skeleton list-row（避免 layout shift）

### D2. 不删 EmptyPane

EmptyPane 是 workspace 内 mobile drawer trigger + center layout 容器，
与 ui-state 正交。其 children 改用 `<EmptyState>` 标准化文案；EmptyPane
本身 wrapping 保留。

### D3. action 是 `<Button>` 而非自渲染

EmptyState / ErrorState 接 `action?: ReactNode` props（不是 callback +
内置 button）。caller 传入完整 `<Button>` 元素，保留 variant 选择。

### D4. 不引入 icon prop（暂）

icon 涉及 lucide 选择 + spacing 决策，本批 skip。如未来需要可加。
当前 EmptyState/ErrorState 仅 title + description + action。

## 落地点

| 文件 | 改动 |
|---|---|
| `web/src/components/ui-state/empty-state.tsx` (新, ~30 LOC) | `<EmptyState title description? action?>` — center-aligned text block + 可选 action |
| `web/src/components/ui-state/error-state.tsx` (新, ~30 LOC) | `<ErrorState message retry?>` — danger color + optional retry button |
| `web/src/components/ui-state/loading-state.tsx` (新, ~20 LOC) | `<LoadingState label?>` — fg-muted text "加载中…" 默认 |
| `web/src/components/ui-state/skeleton.tsx` (新, ~40 LOC) | `<Skeleton variant="list-row"|"text" count?>` — pulse animation 占位 |
| `web/src/components/workspace-main-pane.tsx` | 加载失败 `EmptyPane>加载失败:...</EmptyPane>` 改用 `<ErrorState>`；`<p>加载中…</p>` 改 `<LoadingState>` |
| `web/src/components/my-shares-section.tsx` | 3 处文案改 ErrorState / LoadingState / EmptyState |
| `web/src/components/quota-panel.tsx` | `加载失败：...` 改 `<ErrorState>` |
| `web/src/components/session-list.tsx` | 空态文案改 `<EmptyState>` |
| `web/src/components/new-session-step1-picker.tsx` | `还没有项目` 改 `<EmptyState>` |
| `web/src/components/ui-state/*.test.tsx` (新 4 个) | 各 component smoke test |

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 文案一致 | 4 个 primitive 内部默认 label / variant 统一 |
| a11y | EmptyState `role="status"` / ErrorState `role="alert"` / LoadingState `aria-busy="true"` |
| 无副作用 | 纯展示组件，零 state / 零 effect |
| layout 无回归 | EmptyState / ErrorState text-align center 不改 outer container 行为 |

## 不做

- 不删 EmptyPane（D2）
- 不加 icon prop（D4）
- 不替换 list-base 内 emptyLabel（list 内联用法不需要 primitive 复杂度）
- 不替换 new-session-step2-history 的 emptyLabel（同上）
- 不引入 spinner animation lib（CSS-only 文字提示足够）
