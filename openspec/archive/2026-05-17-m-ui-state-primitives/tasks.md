# Tasks

## 实现 primitives

- [ ] `web/src/components/ui-state/empty-state.tsx`：title + optional description + optional action；center-aligned；role="status"
- [ ] `web/src/components/ui-state/error-state.tsx`：message + optional retry button；text-danger；role="alert"
- [ ] `web/src/components/ui-state/loading-state.tsx`：optional label default `加载中…`；aria-busy="true"；fg-muted
- [ ] `web/src/components/ui-state/skeleton.tsx`：variant="list-row" / "text"；count；animate-pulse；bg-bg-elevated

## 替换散落点

- [ ] workspace-main-pane.tsx: EmptyPane 内加载失败用 ErrorState；`<p>加载中…</p>` 用 LoadingState
- [ ] my-shares-section.tsx: 3 处替换
- [ ] quota-panel.tsx: 加载失败 ErrorState
- [ ] session-list.tsx: 空态 EmptyState
- [ ] new-session-step1-picker.tsx: 空态 EmptyState

## 测试

- [ ] 4 primitive 各 smoke render test
- [ ] 现有 e2e 全过（视觉变化最小）

## BACKLOG + Ship

- [ ] BACKLOG.md 删 B32 条目
- [ ] typecheck + lint + lint:md + test 全绿
- [ ] build:all + healthz 200 + e2e visual 12/12
- [ ] commit + archive
