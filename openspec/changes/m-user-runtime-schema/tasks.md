# Tasks: m-user-runtime-schema

## 前置

- [x] Phase 1.A (m-anthropic-proxy) ship 完成 (99e1fb5 archived
      2026-05-18)

## 实现 — schema

- [x] `src/config/schema.ts`: 加 `isolationPolicy` enum
      (strict/fallback/host-only, default strict) + 注释 (C2)
- [x] `src/config/schema.ts`: 加 `UserConfigSchema.runtime` enum
      (host/shared-container/isolated-container, **default host**
      D2 修订: 既有 prod 不破坏) + 注释 (C2)
- [x] `src/config/schema.ts`: superRefine 拒 `runtime:
      'isolated-container'` (parse 阶段直接 fatal) (C2)

## 实现 — serve.ts

- [x] serve.ts: 拿到 ownerUser 后校验 `config.users[ownerUsername]
      .runtime !== 'host'` → fatal (D3, 防御 undefined: 仅 explicit
      非 host 才 fatal, 既有 prod owner 未列字段时通过) (C2)
- [x] serve.ts: isolationPolicy 处理 (C2)
  - `strict` / `fallback`: 任何非 owner 配 shared-container → fatal
    "Phase 2 not ready" (D5)
  - `host-only`: 全 user override 'host' + warn 列被忽略的 runtime
    override (D4)
- [x] serve.ts: 启动 banner (pino info 一次性，列 runtime breakdown)
      (D7) (C2)
- [x] serve.ts: 传 isolation 状态进 buildServer opts (C2)
- [x] resolveIsolation 拆到 `src/cli/serve-isolation.ts` (避免
      serve.ts 超 300 行 lint cap; 跟 m-anthropic-proxy 时 sse.ts
      拆分一致) (C2)

## 实现 — server.ts /healthz

- [x] `src/server/server.ts`: BuildServerOptions 加可选
      `isolation` field (IsolationStatus 类型: `{ mode, ready,
      reason? }`) (C2)
- [x] `/healthz` route 返 `{ ok: true, isolation: {...} }` 当
      opt 提供, 否则 `{ ok: true }` (向后兼容) (C2)

## 实现 — test fixture

- [x] 5 处 baseConfig 加 `isolationPolicy: 'strict'` (跟 proxy
      字段同处加)，确保现有 test 仍能 build Config (C2)
  - `src/server/server.test-helpers.ts`
  - `src/server/routes/feedback.test.ts`
  - `src/ws/server.test.ts`
  - `src/ws/server.cross-user.test.ts`
  - `src/ws/server.quota-gate.test.ts`

## 测试

- [x] `src/config/schema.test.ts` (8): isolationPolicy enum +
      default + runtime enum + isolated-container 拒 + workspace/
      runtime independence (C2)
- [x] `src/cli/serve.test.ts` (10): happy path 3 + D3 owner 3 + D4
      host-only 3 + D5 strict container fatal 1 (C2, process.exit
      spy 转 ExitCalled error 验证) (C2)
- [x] `src/server/server.test.ts` 加 healthz isolation field (3):
      omit / strict ready / host-only mode (C2)

## docs

- [ ] `docs/deployment.md` §9 isolation 配置段:
      isolationPolicy 三档说明 + per-user runtime 三档说明 +
      Phase 2 启用 container 的预告

## archive

- [ ] proposal status: planned → in-flight → archived
- [ ] mv openspec/changes/m-user-runtime-schema →
      openspec/archive/<date>-m-user-runtime-schema

## commit 拆分

- [ ] C1: openspec proposal + tasks (本笔)
- [ ] C2: schema 字段 + serve 处理 + healthz + 全测试 (主体)
- [ ] C3: docs + archive

## BACKLOG follow-up (不重复落 BACKLOG.md)

- m-user-shared-container (Phase 2 主体, 已记在 proposal 后续段)
- m-runtime-docker-detection (Phase 2 子项)
- m-runtime-degraded-ui-banner (Phase 2 子项)
- m-runtime-status-endpoint (Phase 2 子项)
- m-shared-container-max-users (BACKLOG long-term)
- m-user-isolated-container (reserved long-term)
