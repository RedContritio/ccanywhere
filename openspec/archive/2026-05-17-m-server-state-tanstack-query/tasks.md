# Tasks: m-server-state-tanstack-query (infra-only ship)

## 实现

- [x] `pnpm add @tanstack/react-query`
- [x] main.tsx import QueryClient / QueryClientProvider + 配 default options
- [x] main.tsx wrap App in QueryClientProvider (within ErrorBoundary)

## 验证

- [x] pnpm typecheck:all 全过
- [x] pnpm lint 全过
- [x] pnpm test 458 全过（share/store flaky 单跑过）
- [x] pnpm -F ccanywhere-web test 170 全过
- [x] pnpm -F ccanywhere-web build 成功
- [x] launchctl kickstart 后 healthz 200

## BACKLOG + Commit

- [x] BACKLOG.md 删 B33
- [x] commit
