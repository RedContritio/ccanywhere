# Deployment — user runtime 隔离 (, Phase 1.B)

Phase 1.B 落了**配置层**：admin 声明意图 + 启动校验 + 运维信号
(boot banner + `/healthz` field)。**不**实现容器本身——Phase 2
 才落地真正的 user 容器化 spawn。

主部署文档见 [deployment.md](./deployment.md)；代理（独立进程）
见 [deployment-proxy.md](./deployment-proxy.md)。

## 1. schema 加的两个字段

```json
{
  "isolationPolicy": "strict",
  "users": {
    "alice": { "runtime": "host" }
  }
}
```

两字段都带 zod default，**既有 prod config 零改动可加载**。

### 1.1 `isolationPolicy` （全局）

| 值 | 行为 |
|---|---|
| `strict` (默认) | per-user runtime 按 config；任何 non-owner 配 container → 启动 fatal "Phase 2 not ready" |
| `fallback` | Phase 1.B 等同 strict（docker availability detection 留 Phase 2） |
| `host-only` | 全 non-owner runtime 内存 override `host`，被忽略的 runtime 配置走 audit warn |

默认 `strict` 是 fail-safe — admin 改这个字段会被强迫思考"我在改安
全级别"，命名是 forcing function。

### 1.2 `users.<name>.runtime` （per-user）

| 值 | 行为 |
|---|---|
| `host` (默认) | 跟 owner 同身份跑 (admin-trusted) |
| `shared-container` | Phase 1.B + strict → 启动 fatal；Phase 2 ship 后才真正容器化 |
| `isolated-container` | reserved，schema parse 阶段直接拒（Phase 1+2 都不实现） |

**默认 `host` 而非 `shared-container`** 是为了**向前兼容**——既
有 multi-user prod config 已经有 alice 配 `workspace` 但没配
`runtime`，default `host` 让既有行为不变。Phase 2 ship 时 admin
显式 opt-in `shared-container`。

## 2. owner 强制 host (D3)

`config.users[<owner>].runtime` **必须**是 `host` (或者干脆不在
`users` 字段列 owner——schema default 仍是 `host`)。显式配 owner
runtime 为 `shared-container` 或 `isolated-container` → 启动
fatal。

理由：owner 是 admin、持有真凭据、运行主 ccanywhere server。让
owner 跑容器自我隔离没意义且增加部署复杂度。

## 3. 启动 banner

每次启动 pino info 一行：

```
isolation: strict mode, 3 user(s) on host
  isolationPolicy: "strict"
  effective: "all-host"
  hostUsers: 3
  ownerUsername: "redc"
```

`host-only` 模式额外标记：

```
isolation: host-only mode, 3 user(s) on host (host-only override active)
```

如果有 per-user runtime 被忽略（host-only 模式下非 host 配置）：

```
WARNING: isolationPolicy: host-only — per-user runtime overrides ignored:
  alice=shared-container, bob=shared-container
```

## 4. /healthz isolation field

```bash
$ curl -s http://127.0.0.1:62275/healthz
{ "ok": true, "isolation": { "mode": "strict", "ready": true } }
```

`ready: false` + `reason` 字段保留给 Phase 2（docker 不可用 +
fallback 时降级）使用。Phase 1.B 启动到这步说明所有 container
runtime 配置都已通过 D5 fatal 检查，`ready` 总是 `true`。

## 5. 常用配置示例

### 5.1 单 owner 部署（绝大多数场景）

不配 `isolationPolicy`，不配 `users` (或仅配 workspace overrides)。
schema default 让 owner 自己跑 host，零运维负担。

### 5.2 admin 信任的"小号"（共享 host）

```json
{
  "users": {
    "alice": { "runtime": "host" },
    "bob": { "runtime": "host" }
  }
}
```

`strict` 默认即可——alice / bob 跟 owner 同身份跑。等同 -
user 当前行为。

### 5.3 windows / docker-unavailable 场景

```json
{ "isolationPolicy": "host-only" }
```

强制全 user host 跑（即便将来加了 shared-container 配置也无效）。
启动 banner 显著喊出 "host-only override active" 让 admin 心智
清楚。

### 5.4 Phase 2 ship 后想容器化 alice（**尚未生效**）

```json
{
  "users": {
    "alice": { "runtime": "shared-container" }
  }
}
```

Phase 1.B 启动 fatal："Phase 2 not ready"。等
 ship 后才生效。

## 6. 从  升级（Phase 1.B schema bump，必读）

Phase 1.B 引入 `users.<name>.runtime` 字段，默认 `shared-
container`。**既有 multi-user prod 部署升级后启动 fatal**：

```
fatal: users.alice.runtime: <unset, default shared-container> but
container runtime is Phase 2 — not ready.
Fix: set users.alice.runtime: 'host' OR top-level
isolationPolicy: 'host-only' to override all.
```

这是 deliberate schema bump 行为变更（跟 ccanywhere CLAUDE.md
"Schema bump 必须同步 prod config" 一致），让 admin 主动决策每
个 user 走哪个 runtime，避免 isolation 机制被 default 偷偷绕过。

**两种 migration**:

**6.1 显式 host (跟既有  行为一致)**

每个非 owner user 加 `runtime: 'host'`:

```json
{
  "users": {
    "alice": { "workspace": "/path", "runtime": "host" },
    "bob": { "runtime": "host" }
  }
}
```

效果：alice / bob 跟 owner 同身份跑（既有  行为）。
Phase 2 ship 后想容器化某个 user，再改对应 runtime 为
`shared-container`。

**6.2 全局 host-only (单租户 / windows / 不想 per-user 配)**

```json
{ "isolationPolicy": "host-only" }
```

所有非 owner user runtime 内存 override `host`，per-user
runtime 配置被忽略（audit warn）。适合单 owner 部署 + 偶尔几个
信任的小号场景。

### 升级 checklist

1. `pnpm build:all` 拉新版
2. 编辑 `~/.config/ccanywhere/config.json`：
   - 为每个 user 加 `runtime: 'host'`，**或**
   - 加全局 `isolationPolicy: 'host-only'`
3. `launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere`
4. `curl -sf http://127.0.0.1:62275/healthz` → 必须返
   `{"ok":true,"isolation":{"mode":"strict","ready":true}}` 或
   `"host-only"` mode

## 7. Phase 2 — 已 ship

容器化 spawn 已 ship 在  archive (2026-05-18):
- shared container spawn (docker exec into long-running container,
  per-user CLAUDE_CONFIG_DIR + unix user 隔离 + iptables egress
  锁 api.anthropic.com)
- docker availability detection (启动 + ccanywhere 内部 health
  poll)
- session manager spawn 路径 host/container 分支
- session env 自动注入 ANTHROPIC_BASE_URL/AUTH_TOKEN/
  CLAUDE_CONFIG_DIR + DISABLE_AUTOUPDATER/TELEMETRY

详细见 [deployment-container.md](./deployment-container.md).

仍待 follow-up:
- : web 顶条提示 user 当前 runtime
  (Phase 1.B + 2 都跳过, 改 web 后单独 ship)
- : `fallback` 模式真正"docker
  不可用时 silent override host" 而非 fatal (
  C6 中 fallback 行为仍同 strict; 改 serve-isolation 让 fallback
  + sharedContainerReady=false 时 sliently set perUserRuntime=host)
