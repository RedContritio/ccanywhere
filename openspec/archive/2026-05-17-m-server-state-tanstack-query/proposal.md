---
status: in-flight
---

# Proposal: m-server-state-tanstack-query — TanStack Query infra setup

## Intent

BACKLOG B33（subagent 评审 2 §4）：9 颗 zustand store 把 server fetch +
cache + error 揉一起是 2022 风格；2026 主流是 TanStack Query (server
state) + zustand (UI state) 严格分层。当前 scale 撑得住但**新功能继续
加 store 会增维护负担**。

**实际 ship 范围 ≪ 评审估算 ~200 LOC** — 本笔仅 install + provider
setup（~30 LOC），不强迁任何现有 store。理由：
- 任何 store 迁移（my-shares / sessions / projects）改 fetch/cache/
  invalidation lifecycle，风险大且 scope creep
- subagent 评审本身明示 "新功能从 react-query 起，旧功能不强迁"
- infra ready 后续新需求（quota panel rewrite / feedback list / 等）
  自然用 useQuery；evaluation 已落档

## Scope

- 加 dep `@tanstack/react-query@^5.100`
- `main.tsx` 顶层 wrap `<QueryClientProvider>`，配 client：
  - `refetchOnWindowFocus: false`（ccanywhere 单 user 单 tab，refresh
    无收益）
  - `staleTime: 30_000`（与 use-background-poll 节奏一致）
  - `retry: 1`（避免 flake 自动重试爆炸）

不动：现有 9 颗 zustand store，use-background-poll hook，所有
useEffect+fetch wiring。

## 决策

### D1. infra-only，不迁现有 store

矛盾解决：proposal 原列了 "迁 my-shares + 删 use-background-poll" 但实际
迁移会牵连 share-create-dialog / sessions / projects 三处 lifecycle。
保守仅做 infra setup，让新需求驱动真用例。本次 archive 标 "infra ready，
真用例 follow-up"。

### D2. QueryClient 全局 singleton

不用 per-component 实例（无 SSR / 无 hydration 边界）。

### D3. 不引入 ReactQueryDevtools

dev tool ~20kB + 增 dep。当前 scale 不需要。等真有 query 用例再加。

## 落地点

| 文件 | 改动 |
|---|---|
| `web/package.json` | + `@tanstack/react-query@^5.100` |
| `web/src/main.tsx` | import QueryClient/QueryClientProvider + 配 client + wrap App |

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 现有 store 行为零变化 | 不动 store 文件，不动 useEffect+fetch wire |
| infra ready 验证 | QueryClient instance 创建成功，typecheck/test/build 全过 |
| 性能不退化 | refetchOnWindowFocus:false + retry:1 限制无关 refetch |

## 不做

- 不迁 useSharesStore / useSessionsStore / useProjectsStore（"新功能起" 原则）
- 不删 use-background-poll（依赖 sessions / projects polling）
- 不引入 ReactQueryDevtools（dev tool dep）
- 不加 mutation infra wrapping（等真用例）

## 后续 follow-up（独立 BACKLOG / 启动时机）

- 新功能（如 feedback list 远程查询、新的 metrics 面板）启动时直接用
  `useQuery` + `useMutation`，不要新建 zustand store
- 现有 store 迁移由痛点驱动（add 5+ feature 后 store 真臃肿了再迁），
  不强 backlog 化
