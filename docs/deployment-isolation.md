# Deployment — user runtime 隔离

ccanywhere 支持多 user 部署,每个 non-owner user 可以选 host 或 shared
container 跑。本文档描述 config schema 跟运维行为。

主部署文档见 [deployment.md](./deployment.md);代理见
[deployment-proxy.md](./deployment-proxy.md);容器化细节见
[deployment-container.md](./deployment-container.md)。

## 1. schema 加的两个字段

```json
{
  "isolationPolicy": "strict",
  "users": {
    "alice": { "runtime": "host" }
  }
}
```

两字段都带 zod default,**existing prod config 零改动可加载**。

### 1.1 `isolationPolicy` (全局)

| 值 | 行为 |
|---|---|
| `strict` (默认) | per-user runtime 严格按 config;container runtime 不可用 → 启动 fatal |
| `fallback` | docker 不可用时降级 user runtime 为 host(TODO:当前实现仍同 strict) |
| `host-only` | 全 non-owner runtime 内存 override `host`,被忽略的 runtime 配置走 audit warn |

默认 `strict` 是 fail-safe — admin 改这个字段会被强迫思考"我在改安
全级别",命名是 forcing function。

### 1.2 `users.<name>.runtime` (per-user)

| 值 | 行为 |
|---|---|
| `host` (默认) | 跟 owner 同身份跑(admin-trusted) |
| `shared-container` | 跑在共享 docker container 内(per-user CLAUDE_CONFIG_DIR + unix user 隔离 + iptables egress 锁 api.anthropic.com) |
| `isolated-container` | reserved,schema parse 阶段直接拒(未实现) |

容器化细节见 [deployment-container.md](./deployment-container.md)。

## 2. owner 强制 host

`config.users[<owner>].runtime` **必须**是 `host`(或者干脆不在
`users` 字段列 owner — schema default 仍是 `host`)。显式配 owner
runtime 为 `shared-container` 或 `isolated-container` → 启动 fatal。

理由:owner 是 admin、持有真凭据、运行主 ccanywhere server。让
owner 跑容器自我隔离没意义且增加部署复杂度。

## 3. 启动 banner

每次启动 pino info 一行:

```
isolation: strict mode, 3 user(s) on host
  isolationPolicy: "strict"
  effective: "all-host"
  hostUsers: 3
  ownerUsername: "owner"
```

`host-only` 模式额外标记:

```
isolation: host-only mode, 3 user(s) on host (host-only override active)
```

如果有 per-user runtime 被忽略(host-only 模式下非 host 配置):

```
WARNING: isolationPolicy: host-only — per-user runtime overrides ignored:
  alice=shared-container, bob=shared-container
```

## 4. /healthz isolation field

```bash
$ curl -s http://127.0.0.1:8081/healthz
{ "ok": true, "isolation": { "mode": "strict", "ready": true } }
```

`ready: false` + `reason` 字段在 docker 不可用时返回(`strict` 模式下
启动会先 fatal,不会到这步)。

## 5. 常用配置示例

### 5.1 单 owner 部署(绝大多数场景)

不配 `isolationPolicy`,不配 `users`(或仅配 workspace overrides)。
schema default 让 owner 自己跑 host,零运维负担。

### 5.2 admin 信任的"小号"(共享 host)

```json
{
  "users": {
    "alice": { "runtime": "host" },
    "bob": { "runtime": "host" }
  }
}
```

`strict` 默认即可 — alice / bob 跟 owner 同身份跑。

### 5.3 windows / docker-unavailable 场景

```json
{ "isolationPolicy": "host-only" }
```

强制全 user host 跑(即便配了 `shared-container` 也无效)。启动 banner
显著喊出 "host-only override active" 让 admin 心智清楚。

### 5.4 容器化 alice

```json
{
  "users": {
    "alice": { "runtime": "shared-container" }
  }
}
```

需要 docker daemon 可达 + 容器 image 已 build(见
[deployment-container.md](./deployment-container.md))。

## 6. 从老版 schema 升级

某个版本之前 `users.<name>.runtime` 字段不存在。升级后 existing multi-user
prod config 启动 fatal:

```
fatal: users.alice.runtime: <unset, default shared-container> but
container runtime not ready.
Fix: set users.alice.runtime: 'host' OR top-level
isolationPolicy: 'host-only' to override all.
```

这是 deliberate fail-safe — 让 admin 主动决策每个 user 走哪个 runtime,
避免 isolation 机制被 default 偷偷绕过。

**两种 migration**:

### 6.1 显式 host(跟 existing 行为一致)

每个非 owner user 加 `runtime: 'host'`:

```json
{
  "users": {
    "alice": { "workspace": "/path", "runtime": "host" },
    "bob": { "runtime": "host" }
  }
}
```

### 6.2 全局 host-only(单租户 / windows / 不想 per-user 配)

```json
{ "isolationPolicy": "host-only" }
```

所有非 owner user runtime 内存 override `host`,per-user runtime 配置
被忽略(audit warn)。适合单 owner 部署 + 偶尔几个信任的小号场景。

### 升级 checklist

1. `pnpm build:all` 拉新版
2. 编辑 `~/.config/ccanywhere/config.json`:
   - 为每个 user 加 `runtime: 'host'`,**或**
   - 加全局 `isolationPolicy: 'host-only'`
3. `launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere`
4. `curl -sf http://127.0.0.1:8081/healthz` → 必须返
   `{"ok":true,"isolation":{"mode":"strict","ready":true}}` 或
   `"host-only"` mode

## 7. 已知 follow-up

- `fallback` 模式真正"docker 不可用时 silent override host" 而非
  fatal(当前 fallback 行为仍同 strict)
- web 顶条提示 user 当前 runtime
