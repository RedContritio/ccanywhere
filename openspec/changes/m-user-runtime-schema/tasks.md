# Tasks: m-user-runtime-schema

## 前置

- [x] Phase 1.A (m-anthropic-proxy) ship 完成 (99e1fb5 archived
      2026-05-18)

## 实现 — schema

- [ ] `src/config/schema.ts`: 加 `isolationPolicy` enum
      (strict/fallback/host-only, default strict) + 注释
- [ ] `src/config/schema.ts`: 加 `UserConfigSchema.runtime` enum
      (host/shared-container/isolated-container, default
      shared-container) + 注释
- [ ] `src/config/schema.ts`: superRefine 拒 `runtime:
      'isolated-container'` v1 不实现 (跟 spec.md '决策 D2' 一致)

## 实现 — serve.ts

- [ ] serve.ts: 拿到 ownerUser 后校验 `config.users[ownerUsername]
      .runtime !== 'host'` → fatal (D3)
- [ ] serve.ts: isolationPolicy 处理
  - `strict` / `fallback`: 任何非 owner 配 container → fatal
    "Phase 2 not ready" (D5)
  - `host-only`: 全 user override 'host' + warn 列被忽略的 runtime
    override (D4)
- [ ] serve.ts: 启动 banner (pino info 一次性，列 runtime breakdown
      + degraded warning if any) (D7)
- [ ] serve.ts: 传 isolation 状态进 buildServer opts

## 实现 — server.ts /healthz

- [ ] `src/server/server.ts`: BuildServerOptions 加可选
      `isolation` field (`{ mode, ready, reason? }`)
- [ ] `/healthz` route 返 `{ ok: true, isolation: {...} }` (字段
      可选，向后兼容当前 `{ ok: true }`)

## 实现 — test fixture

- [ ] 5 处 baseConfig 加 `isolationPolicy: 'strict'` (跟 proxy
      字段同处加)，确保现有 test 仍能 build Config
  - `src/server/server.test-helpers.ts`
  - `src/server/routes/feedback.test.ts`
  - `src/ws/server.test.ts`
  - `src/ws/server.cross-user.test.ts`
  - `src/ws/server.quota-gate.test.ts`

## 测试

- [ ] `src/config/schema.test.ts`: enum 校验 + default 行为 +
      isolated-container 拒
- [ ] serve.ts 启动 unit test: owner host fatal / strict +
      container fatal / host-only override
- [ ] server.ts /healthz field 注入 unit test

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
