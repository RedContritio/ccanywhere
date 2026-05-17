---
status: archived
---

# Proposal: m-user-runtime-schema — isolationPolicy + per-user runtime

## Intent

Phase 1.A (m-anthropic-proxy) 落了代理基础设施；本笔 (Phase 1.B)
落配置层 + 运维信号，让 owner 在 Phase 2 容器化 ship 前就能：

1. **声明意图**：哪些 user 应该容器化，哪些保留 host
2. **看到模式**：启动 banner 列每个 user runtime；/healthz 暴露
   isolation status；degraded 状态不静默
3. **拒绝错误配置**：owner 配 container = fatal；container runtime
   配置在 Phase 1 时 fatal "not ready"，避免静默回退到 host

Phase 1.B **不**实现容器本身（Phase 2 m-user-shared-container）；
不做 docker availability detection；不做 web UI 顶条。

## Scope

### schema 加字段（两个新增）

```ts
// 全局 (config.isolationPolicy)
isolationPolicy: z
  .enum(['strict', 'fallback', 'host-only'])
  .default('strict'),

// per-user (config.users.<name>.runtime)
const UserConfigSchema = z.object({
  workspace: z.string().optional(),
  runtime: z
    .enum(['host', 'shared-container', 'isolated-container'])
    .default('shared-container'),
});
```

两字段都带 zod default：parse 永远成功，但 **D2 amendment 后既有
multi-user prod 启动会 fatal** (runtime default 是 shared-
container, serve.ts D5 强制 fatal until admin 显式配 runtime 或
切 host-only)。这是 deliberate schema bump 行为变更, 见
deployment-isolation.md §6 升级步骤。

### 启动行为（serve.ts）

owner 强制 host：
- 校验 `config.users[ownerUsername]?.runtime` 不能 ≠ 'host'
- 不配 = 默认 'shared-container' 也算违反 → fatal
- mitigation：owner 隐式 'host'，但要求 owner 显式声明
  以保证 config-as-source-of-truth

isolationPolicy 行为：
- `strict`：按 per-user runtime 跑；任何非 owner user 配
  `shared-container` 或 `isolated-container` → fatal "Phase 2 not
  ready, fall back to runtime: 'host' or set
  isolationPolicy: 'host-only' to override all"
- `fallback`：Phase 1 等同 strict (docker availability detection
  留 Phase 2)
- `host-only`：所有非 owner user 内存里 override 'host'，warn 列
  出被忽略的 runtime override

启动 banner（main server，跟 proxy 平行）：

```
[server] isolationPolicy: strict
[server] runtime breakdown:
  - owner (host): 1 user
  - host (admin-trusted): N users
  - shared-container (Phase 2 pending): N users
  - isolated-container (reserved): N users
[server] WARNING: ... (if degraded)
```

healthz field：
- `GET /healthz` 返 `{ ok: true, isolation: { mode, ready } }`
- `ready: true` ⇔ 所有配置都能立即满足（host-only 模式 / strict 模
  式且无 container user）
- `ready: false` + reason 字符串 ⇔ 配置含 container runtime 但
  Phase 2 未 ready

### 不在 Phase 1.B 范围

- 容器实际启动（Phase 2 m-user-shared-container）
- docker availability detection
- session manager spawn 路径分支（Phase 2，目前所有 user 仍走
  owner host 路径）
- web UI degraded 红条
- /api/internal/runtime-status 端点

## 决策

### D1. 三档 isolationPolicy（默认 strict）

```
strict     默认。docker 必须可用 (Phase 2 才检测)，任何 container
           runtime 配置都需要 Phase 2 已 ready 才放行；Phase 1.B
           ship 时 container runtime → fatal "not ready"
fallback   等同 strict（Phase 2 加 docker detection 后才有区别）
host-only  全 user override host，per-user runtime 被忽略
```

理由：默认 strict 是 fail-safe。owner 改这个字段会被强迫思考"我
在改安全级别"。命名是 forcing function。

### D2. 三档 per-user runtime（默认 shared-container）

> **⚠️ C4 Amendment (2026-05-18, on m-user-runtime-schema branch)**:
> C2 ship 时把 D2 default 修订为 'host' (理由: 既有 prod 不破坏);
> review 后撤回回到原 D2 default 'shared-container'. 理由:
> - default 应反映方向 (Phase 2 容器化是目标); 'host' 让既有 prod
>   永远不容器化, owner 加新 user 默认 host = 隐藏 isolation 机制
> - 既有 prod schema bump 应走 ccanywhere 显式同步流程 (CLAUDE.md
>   "Schema bump 必须同步 prod config" + #44 教训), 不靠 default
>   偷偷继承旧行为
> - 既有 prod 启动 fatal "users.X.runtime undefined, set host or
>   切 host-only" 是合理 prompt, 不是缺陷
>
> 同时撤回 D7 "既有 prod 零改动" wording (跟 default shared-
> container 矛盾). 修订后 D7 是 "Phase 1.B 是 schema bump 行为变更,
> 既有 prod 部署后启动 fatal 直到 admin 显式配 runtime".

```
host                  跟 owner 同身份跑 (admin-trusted); owner
                      MUST be 'host' (D3)
shared-container      默认。反映 Phase 2 方向; Phase 1.B 配置或
                      未显式配 (default applied) → 启动 fatal
                      "Phase 2 not ready"; Phase 2 ship 后才真容器
isolated-container    reserved schema enum; Phase 1+2 都不实现;
                      parse 阶段直接 zod superRefine 拒
```

理由 (default 'shared-container'): default 反映目标架构而不是既有
行为。admin 必须主动声明每个 user 走哪个 runtime — 不让 isolation
机制被 default 偷偷绕过。既有 multi-user prod 升级走显式 schema
bump 同步流程 (deployment-isolation.md §6 升级步骤)。

理由 (rejected isolated-container at parse time): 真正不可信 user
才需要 per-user 独立容器; ccanywhere 当前 use-case (owner + admin-
trusted 小号) 不需要。schema 接受 enum 是 forward-compat, parse
拒避免 owner 写错以为安全实际无效。

### D3. owner 强制 host (fatal)

- schema 不校验（owner username 是 runtime 概念，schema 阶段不
  知道是哪个）
- serve.ts 启动时拿到 ownerUser 后校验
- `config.users[ownerUsername]?.runtime ≠ 'host'` → fatal

理由：owner 是 admin、有真凭据，跑容器自我隔离没意义且增加部署复
杂度。CLAUDE.md 写过"双栈是有意为之 (owner host / user
container)"。

### D4. host-only override + audit log

`isolationPolicy: 'host-only'` 时：
- 所有非 owner user 的 runtime 内存里强制 'host'
- log warn 列出被忽略的 runtime override (列出 user 名 + 原 runtime
  值)
- banner 标 `host-only` 模式

理由：避免 owner 在 windows / 性能场景下漂移到 fail-open 状态而
不自知。

### D5. strict 模式 + container runtime → fatal "not ready"

Phase 1.B ship 时容器化 (Phase 2) 未 ready，所有非 host runtime
配置启动 fatal：

```
fatal: user 'alice' configured runtime: 'shared-container' but
container runtime is Phase 2 (m-user-shared-container) — not ready.
Fix: set runtime: 'host' or top-level isolationPolicy: 'host-only'.
```

理由：fail-loud 而非 silent fallback。owner 主动配 container =
意图明确，Phase 1.B 不该悄悄当 host 跑。等 Phase 2 ship 后这条
fatal 转为 "spawn container"。

### D6. Phase 1.B 不做 docker availability detection

理由：detection 仅为 fallback 模式语义服务；Phase 1.B 容器路径全
fatal，detection 没意义。Phase 2 ship 时跟容器 lifecycle 一起加。

### D7. 启动 banner + healthz field 是 minimal 运维信号

Phase 1.B 仅落两处 noisy 提示：
- 启动 banner（pino info 一次性日志）
- /healthz field（持续可查）

不落：
- web UI 顶条（Phase 2 一起做 — degraded 提示要 user 看到 UI）
- /api/internal/runtime-status（按需，Phase 2 加）
- 启动 chunked report（每 user 一行的详细列）— banner 已经够

### D8. session manager 不动

session manager 当前按 owner identity spawn；Phase 1.B 不引入
runtime 分支。Phase 2 m-user-shared-container 才在 spawn 前根据
`user.runtime` 路由到 host / shared / isolated 三个分支。

## 落地点

| 文件 | 改动 |
|---|---|
| `src/config/schema.ts` | + `isolationPolicy` + `users.<name>.runtime` + 注释 |
| `src/cli/serve.ts` | + owner host 校验 + isolationPolicy 处理 + banner |
| `src/server/server.ts` | `/healthz` 接受 `isolation` opt 注入 response |
| 5 个 test fixture | 加 `isolationPolicy` field (defaults 也可省) |
| `src/config/schema.test.ts` (新) | enum / default / user runtime 校验 |
| `src/cli/serve.test.ts` (新) | startup behavior unit test |
| `docs/deployment.md` §9 | isolation 配置段 + isolationPolicy 选项说明 |

预估 ~250 LOC src + ~200 LOC test。比 Phase 1.A (~1600 LOC src) 小一档。

## 形式化保证

| 性质 | 机制 |
|---|---|
| Phase 1.B 是 schema bump 行为变更 (D2 amendment) | 既有 multi-user prod 部署后启动 fatal until admin 显式配 user runtime; deployment-isolation.md §6 升级步骤; 跟 ccanywhere CLAUDE.md schema bump 流程一致 |
| owner 永远 host 身份 | serve.ts startup fatal (D3) |
| Phase 1.B 时 container 配置不静默回退 | strict + container → fatal (D5) |
| 配置可见性 | 启动 banner + healthz field (D7) |
| host-only 模式不静默 fail-open | warn list + banner 显式 (D4) |
| Phase 2 ship 时本笔仍向前兼容 | enum 字段，Phase 2 在 D5 fatal 处换 spawn 容器 |

## 不做

- 容器实际启动 (Phase 2 m-user-shared-container)
- docker availability detection (Phase 2)
- web UI degraded 红条 (Phase 2，前端改造一起)
- /api/internal/runtime-status 端点 (按需 Phase 2)
- session manager spawn 路径分支 (Phase 2)
- 自动告警 (跟 m-anthropic-proxy D7 一致 — 靠运维主动看 banner /
  healthz)

## 后续 follow-up

- **m-user-shared-container** (Phase 2 主体): 实现 shared-container
  runtime + docker spawn + lifecycle + iptables + CLAUDE.md inject
- **m-runtime-docker-detection** (Phase 2 子项): docker
  availability 启动+周期检测，让 `fallback` 模式真正生效
- **m-runtime-degraded-ui-banner** (Phase 2 子项): web 顶条提示
  user 当前在 degraded mode
- **m-runtime-status-endpoint** (Phase 2 子项): /api/internal/
  runtime-status 暴露 admin 详细状态
- **m-shared-container-max-users** (BACKLOG long-term): schema 加
  `maxSharedUsers` cap (避免一容器塞 100 user)
- **m-user-isolated-container** (reserved long-term): 真正的
  per-user 独立容器，给"真不可信外部 user" 用
