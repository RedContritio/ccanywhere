---
status: archived
---

# Proposal: m-user-shared-container — Phase 2 容器化主体

## Intent

Phase 1.A (m-anthropic-proxy) 落了代理基础设施；Phase 1.B
(m-user-runtime-schema) 落了 schema + 启动校验，但 `runtime:
'shared-container'` 配置仍走 fatal "Phase 2 not ready"。本笔
(Phase 2) ship 容器化 spawn 主体：

1. 一个 shared container per ccanywhere instance (跟 ccanywhere
   server 同 lifecycle，启动时 ensure，关闭时 destroy)
2. session manager 按 `user.runtime` 分支 spawn：
   - `host` → 既有 PTY spawn 路径
   - `shared-container` → `docker exec -it <shared> -u <user> claude ...`
3. shared container 内 per-user unix account + `CLAUDE_CONFIG_DIR`
   + iptables egress 锁到 proxy endpoint
4. user 容器内 claude 走 `ANTHROPIC_BASE_URL`
   → ccanywhere-anthropic-proxy → owner key → upstream

spike 数据 (spike-p3-p4.md) 解决了两个关键不确定性：
- **cold start** 不是问题 (`docker exec` 60ms / `docker run` 180ms,
  UX 不可感知)
- **node-pty + docker exec -it 双 tty 完美透传** (echo / resize /
  ANSI color 全 OK)

## Scope

### shared container lifecycle

新增 `src/container/shared-manager.ts`:
- `ensureRunning()`: 启动时 docker run -d 起 shared container；如
  果已存在则验证 health (docker exec ... true)，不健康则
  recreate
- `stop()`: ccanywhere shutdown 时 docker rm -f
- 自动 respawn: docker daemon 自动 restart 容器 (--restart unless-
  stopped)，外加 ccanywhere 周期 health-check (30s)，连续 3 次
  fail 时 fatal log + container exit (用户介入)

### Dockerfile + image build

新增 `docker/Dockerfile.ccanywhere-user` (在 repo root 不在
src/):
- base: `node:20-alpine`
- install: iptables + shadow + ca-certificates + bash + curl
  (apk) + `npm install -g @anthropic-ai/claude-code` (Linux 版
  claude-code, D7 第二次修订)
- entrypoint (`docker/entrypoint.sh`): hosts override
  (api.anthropic.com → 127.0.0.1, 零 cap requirement) + iptables
  REJECT api.anthropic.com (best-effort, 需 NET_ADMIN cap) +
  sleep infinity. per-user account 不在 entrypoint 建, 由
  user-sync.ts (C4) 在 ccanywhere 加 user 时 docker exec useradd
- `scripts/build-container-image.sh`: docker build + tag helper
- `scripts/container-manual-verify.sh`: image build + run +
  iptables/hosts/claude 验证 (跟 proxy-manual-verify.sh 同款
  manual gate)

### session manager spawn 分支

改 `src/session/manager.ts` `spawn(opts)`：按 `opts.runtime`
('host' / 'shared-container') 决定 ptySpawn 第 1 参数。host 路径
不变；shared-container 路径 = `ptySpawn('docker', ['exec', '-it',
SHARED_CTN, '-u', opts.unixUid, opts.command, ...opts.args],
{cols, rows, env})`。

env 注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (bearer
来自 ccanywhere-anthropic-proxy CLI 颁发) + `CLAUDE_CONFIG_DIR=
/home/<user>/.claude` + `DISABLE_AUTOUPDATER=1` +
`DISABLE_TELEMETRY=1`。

### resolveIsolation 解锁 shared-container

m-user-runtime-schema D5 当前: strict + 'shared-container' →
fatal "Phase 2 not ready"。本笔后改: 验证 docker daemon 可达 +
shared container 健康 → 允许 'shared-container' 跑；docker 不可
达且 isolationPolicy 是 'fallback' → 全 user override host +
warn；'strict' + docker 不可达 → fatal。

### user 工作区 mount

shared container 内每 user 看到 workspace 映射到
`<host workspace>/<username>` (m-multi-user 已有的 per-user
workspace) 挂到 `/home/<user>/workspace`。

### CLI 改

- `ccanywhere container build` 子命令: 构建 image (CI / 升级用)
- `ccanywhere container ensure` 子命令: 手动 ensure shared
  container running (debug 用)

## 决策

### D1. shared container (单容器多 unix user) 而非 per-user container

理由跟 m-user-runtime-schema D1 一致: "自用 + 小号" use-case 不
需要 untrusted multi-tenant 强度，单容器 + chmod 隔离够。降低
container resource footprint (单容器 ~100MB RAM 复用)。

如果未来需要"真不可信外部 user"，按 m-user-runtime-schema D2
reserved 的 `isolated-container` 实现 (新 follow-up
m-user-isolated-container)。

### D2. lifecycle: long-running shared container + docker exec per session

spike F2 实证 docker exec (60ms) vs docker run (180ms)，shared
container + exec 略快但**两者都不可感知**。选 shared 的实际理由
不是 latency，是 cost-optimization + per-user state 持久 (每 user
home dir 有自己 cc history)。

### D3. ANTHROPIC_AUTH_TOKEN 走 env 注入 (不走 ~/.claude/.credentials.json 文件)

m-anthropic-proxy spike 已确认 claude binary 完全 honor
ANTHROPIC_AUTH_TOKEN env。容器内 env 注入比写文件 + 同步 inotify
简单得多。token 5min TTL (跟代理颁发一致) + apiKeyHelper rotation
(后续 follow-up)。

### D4. per-user unix account in shared container

每个 ccanywhere user (alice / bob / ...) 在 shared container 启
动时 useradd 一个对应 unix account (UID 跟 username hash 派生)。
spawn `docker exec -u <user>` 让 claude 跑在该 user 身份下。
filesystem 隔离: `/home/<user>` mode 0700。

ccanywhere CLI 新增 user 时同步在 container 内 useradd (run-time
mutation OR container restart-on-user-change)。两种 trade-off 在
实现时决 — 倾向 run-time mutation (减少 restart 频率)。

### D5. iptables egress 仅锁 api.anthropic.com (默认 ACCEPT)

shared container 启动时 init script 跑 iptables:
- DROP: outgoing to api.anthropic.com (强制 anthropic 流量经代理)
- ACCEPT: rest (github / web_search / MCP servers / 其他外部 API)
- ACCEPT: loopback + host.docker.internal:62276 (proxy)

需要容器 `--cap-add NET_ADMIN`。这是 anthropic 流量经代理的
**enforcement 最后一道锁**——claude 不能绕开代理直连
api.anthropic.com 烧 owner 配额。

**修订自原 D5 (default-DROP only-allow-proxy)**: claude 工具体系
里 github MCP / web_search / fetch_url 等需要广域外部访问，全
DROP 会断主要功能。仅 DROP anthropic 强制走代理，其他放行。

**代价**: claude 内部如有 hardcoded telemetry 走非 anthropic 域名
(如 anthropic-cdn / segment.io / amplitude) 会**绕过 enforcement**。
mitigation: `DISABLE_TELEMETRY=1` env 兜底 (m-anthropic-proxy
spike P2 实测无非 anthropic.com 直连)。低风险, 接受。

### D6. docker availability detection (m-runtime-docker-detection 内联)

ccanywhere 启动时 `docker info` exit 0 + 能跑 `docker run --rm
alpine true` (实际容器拉起) 才算 ready。`fallback` 模式下 docker
不可达 → 全 user override host + warn。`strict` 模式 docker 不可
达 → fatal。

周期 health check (30s): docker daemon 中途挂掉 → log warn + 切
degraded mode (但不 down ccanywhere; user-affecting fatal 是过
度反应)。

### D7. claude binary 在 image 内 vendor via `npm install -g` (D7 第二次修订)

Dockerfile RUN `npm install -g @anthropic-ai/claude-code`. 容器内
`/usr/local/lib/node_modules/@anthropic-ai/claude-code` + PATH 内
`claude` shim. 不 mount host claude binary.

**修订历史**:
- 原 D7: vendor (手动 copy binary 进 image), 跟 ccanywhere version
  tag
- D7 第一次修订: mount host claude (`-v config.claudeBin:/usr/
  local/bin/claude:ro`), 复用 claudeBin 配置
- **D7 第二次修订 (本次)**: mount 撞 ABI 墙 — host claude 是
  macOS Mach-O native (Bun 编译, 含 `__BUN`/`__PAGEZERO`/`/usr/lib
  /dyld` sections), Linux 容器跑 `exec format error`. mount 不可
  行. 改回 vendor 但用 `npm install -g` 工程化分发 (vs 手动 copy
  binary 文件).

**为何 npm install 而非手动 copy**:
- npm 是 claude 官方分发渠道 — 标准, 0 手动 artifact 管理
- 跟 ccanywhere image 一起 tag (image rebuild = claude 升级)
- 默认拉 latest; ccanywhere 想 pin 在 Dockerfile 改成
  `@anthropic-ai/claude-code@<version>` 即可

**P7 spike 验证**: scripts/container-manual-verify.sh `claude
--version` 在 alpine npm-installed 容器内输出 `2.1.143 (Claude
Code)`. Linux 版 claude-code npm 包跟 musl (alpine) 兼容.

**代价**:
- image 663MB (vs 225MB 不含 claude). 一次性 build, ccanywhere
  instance 启动 ensure 时复用. acceptable.
- claude 每次 release ccanywhere image 要 rebuild + restart shared
  container. 自动化: `scripts/build-container-image.sh` + 后续
  ccanywhere instance auto-pull (TBD).

### D8. shared container 失败的 blast radius

shared container 崩溃 → 所有 user session 一起 die。这是 D1
shared container 的接受代价 (m-user-runtime-schema D1 决策时
明示过 "故障域共享")。

mitigation: ccanywhere 自动 respawn shared container; user session
crash 后 ccanywhere 通知 user "session terminated, please reload"
(WS 4002 close)。

## 落地点

| 文件 | 改动 |
|---|---|
| `docker/Dockerfile.ccanywhere-user` (新) | shared container image 定义 |
| `docker/entrypoint.sh` (新) | iptables init + useradd users + sleep infinity |
| `scripts/build-container-image.sh` (新) | docker build + tag helper |
| `src/container/shared-manager.ts` (新) | lifecycle (ensure / health / stop) |
| `src/container/user-sync.ts` (新) | useradd / userdel in running container |
| `src/container/docker-detect.ts` (新) | docker availability check + periodic re-check |
| `src/session/manager.ts` (改) | spawn 按 user.runtime 分支 |
| `src/cli/serve.ts` (改) | ensure shared container 启动 + lifecycle 接 graceful shutdown |
| `src/cli/container-cmd.ts` (新) | `ccanywhere container {build,ensure,stop}` 子命令 |
| `src/cli.ts` (改) | 注册 container 子命令 |
| `src/cli/serve-isolation.ts` (改) | resolveIsolation D5 解锁 shared-container; D6 加 docker detection |
| `src/users/store.ts` (改) | createUser/deleteUser hook 触发 container user-sync |
| `docs/deployment-container.md` (新) | 容器化部署文档 |
| `docs/deployment-isolation.md` (改) | §6 升级步骤改 (Phase 2 后 shared-container 真生效) |

预估 ~1500-2000 LOC src + ~600-800 LOC test + 200 LOC docs +
Dockerfile + init script. **Phase 2 比 Phase 1.A 大 1.5-2x**。

## 形式化保证

| 性质 | 机制 |
|---|---|
| 容器内 claude anthropic 流量必经代理 | D5 iptables DROP api.anthropic.com (其他外部 API 如 github/web_search 仍 ACCEPT) |
| owner 真凭据不进容器 | env 注入的是 ccanywhere-issued bearer，proxy 才有 owner key |
| user 间 fs 隔离 | D4 per-user unix account + /home/<user> mode 0700 |
| user 间 process 隔离 (best-effort) | unix user UID 分隔，ptrace_scope 容器 init 时设 |
| docker 不可达不 silent fail | D6 strict fatal / fallback override + warn |
| owner spawn 路径零回归 | session manager spawn 按 runtime 分支，host 路径不变 |
| shared container 崩溃可恢复 | docker --restart + ccanywhere 周期 health 30s |

## 不做

- `isolated-container` runtime 实现 (m-user-isolated-container,
  reserved long-term)
- macOS Keychain in container (Linux container 走文件凭据，环境
  已对)
- web UI degraded 顶条 (m-runtime-degraded-ui-banner 子项，独立
  ship)
- `/api/internal/runtime-status` 端点 (m-runtime-status-endpoint
  子项，按需)
- claude binary auto-update 进容器 (容器内 DISABLE_AUTOUPDATER=1，
  image rebuild 才升)
- windows 支持 (BACKLOG, docker-on-windows 本身可能用 docker
  desktop，但 LaunchAgent → Windows Service 等一堆需要 m-windows-
  support 独立 ship)

## 后续 follow-up

- **m-user-isolated-container** (reserved long-term): per-user
  独立容器, 给"真不可信外部 user" 用
- **m-runtime-degraded-ui-banner** (Phase 2 子项独立 ship): web 顶
  条提示 user "你当前 host mode"
- **m-runtime-status-endpoint** (Phase 2 子项独立 ship):
  /api/internal/runtime-status 暴露 admin
- **m-shared-container-max-users** (BACKLOG long-term): schema 加
  `maxSharedUsers` cap
- **m-proxy-quota-sync** (本笔 + m-anthropic-proxy 共同 follow-up):
  proxy 账本与 UserStore.quota.usedUsd 双向 sync
- **m-windows-support** (BACKLOG long-term): windows 整体支持
- **m-container-apikey-helper** (Phase 2 子项): apiKeyHelper script
  注入容器, 让 5min TTL token 自动 rotation (vs 每次 session 启动
  新颁发)

## 前置 prototype

- ✅ P2 (m-anthropic-proxy spike): ANTHROPIC_BASE_URL +
  ANTHROPIC_AUTH_TOKEN 透传验证
- ✅ P3 / P3.5 / P4 (本笔 spike-p3-p4.md): cold start + docker
  exec latency + node-pty 双 tty 透传
- P5/P6/P7/P8 在 implementation 时按子任务 verify (不阻塞 proposal)
