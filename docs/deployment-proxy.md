# Deployment — anthropic 代理 (m-anthropic-proxy, Phase 1)

独立 LaunchAgent 进程 `ccanywhere proxy serve`，listen
`config.proxy.port` (default 62276) on `config.proxy.bindHost`
(default 127.0.0.1)。**owner 路径不经此代理** (D7)，仅为 Phase 2
user 容器化做的基础设施。Phase 1 ship 后没真实流量经过；靠
`scripts/proxy-manual-verify.sh` + 单元测试验证。

主部署文档见 [deployment.md](./deployment.md)。

## 1. owner 真凭据

两种 auth 二选一 (D8 amendment 支持两路径):

**a. Console API key (按 token 计费)**

```bash
read -s ANT_KEY  # paste sk-ant-...
printf '{"apiKey":"%s"}\n' "$ANT_KEY" > ~/.config/ccanywhere/anthropic-credentials.json
chmod 600 ~/.config/ccanywhere/anthropic-credentials.json
unset ANT_KEY
```

proxy 转发用 `X-Api-Key` header. 走 Console billing.

**b. Claude Code subscription OAuth (复用 Pro/Max plan, 推荐)**

先在 owner mac 本机 (跟 claude 已登录的 user) 跑:

```bash
claude setup-token   # 走 browser OAuth, 1 年期 token 打印到 terminal
```

然后:

```bash
read -s OAUTH        # paste sk-ant-oat-...
printf '{"oauthToken":"%s"}\n' "$OAUTH" > ~/.config/ccanywhere/anthropic-credentials.json
chmod 600 ~/.config/ccanywhere/anthropic-credentials.json
unset OAUTH
```

proxy 转发用 `Authorization: Bearer`. 走 owner Claude Pro/Max
subscription quota, **不**消耗 Console credit。Token 1 年期, 到期
重跑 `claude setup-token`。

**两个都配** 时 proxy 优先用 oauthToken (subscription) → 适合
admin 偶尔切回 apiKey 调试时.

- 文件不存在 → 代理以 **503 模式**启动 (admin 可以晚配，不
  crash-loop)，所有 forward 路由返 503
- mode 不是 0600 → 启动 fatal (拒绝读其他 user 可读的 key 文件)
- malformed JSON / `apiKey` + `oauthToken` 都缺 → 启动 fatal

**任何 commit 进 git 前**检查这个文件没被加进，避免泄漏。

## 2. 启动方式：由 ccanywhere main 自动 spawn (D7 amendment)

**早期 ship (m-anthropic-proxy 原 D1) 用独立 LaunchAgent**，但 owner
实际部署时容易忘装（实际 evidence: prod 第一次部署就漏了，proxy 全程
没跑过）。m-host-credentials-share D7 amendment 改为 **ccanywhere main
process 启动时通过 `child_process.spawn` 起 proxy 子进程**：

- **独立 OS process** — credentials 文件 read 仅在 proxy 子进程，main
  process RCE 不直接拿到 owner key（D1 blast radius 保留）
- **lifecycle 绑定** — 装 `~/Library/LaunchAgents/com.<you>.ccanywhere
  .plist` 一个就够；main 起 = proxy 起，main 停 = proxy 停
- **mini supervisor** — proxy 子进程 crash 时按退避序列重启
  (1s/2s/5s/10s/30s)；60s 窗口内连续 5 次 crash 触发 give-up，main 继续
  跑（owner host 路径仍能用）
- **log 独立** — stdio 重定向到 `<configDir>/proxy.log` (mode 0600)
- **shutdown 顺序** — main 收 SIGTERM → 先 stop containers → SIGTERM
  proxy 子进程 → 5s grace → SIGKILL → main exit

**用户无需任何 LaunchAgent 安装步骤**。第一节配好 credentials 文件 +
`launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere` 后 proxy
自动跑起来：

```bash
curl -sf http://127.0.0.1:62276/healthz
# 应返 {"ok":true,"mode":"ready"} (有 credentials)
# 或   {"ok":true,"mode":"degraded"} (credentials 缺失，仍接 HEAD/healthz
# 但 forward 路由都返 503/404)
```

debug proxy 子进程：

```bash
pgrep -fa 'proxy serve'           # 找 PID
tail -f ~/.config/ccanywhere/proxy.log
```

## 3. D10 反转 (2026-05-20): proxy 当前不在 user 流量路径上

**重要**: m-host-credentials-share D10 amendment 反转 proxy 在 user
spawn 路径的 wire — 经验上 Anthropic 2026-02 起明确禁止第三方应用
通过 Authorization: Bearer 转发 OAuth subscription token (cc binary
自身仍可走 first-party). proxy 仍 listen `127.0.0.1:62276` (main
process cohost spawn, D7) 作 **future fallback**:

- anthropic 改回允许第三方 proxy → 反向 wire 即可
- owner 切 Console API key (`sk-ant-api03-...` 烧 credit) → proxy
  forward X-Api-Key 走 Console billing, 此路径 anthropic 仍允许

当前 user 流量 (m-user-shared-container shared-container path) **不
经 proxy**: 容器内 cc 用 `CLAUDE_CODE_OAUTH_TOKEN` env (容器内 issued
via `claude setup-token`, 容器内 use, 同 device fingerprint) 直连
`api.anthropic.com`. session-runtime D10 inject env, entrypoint 撤
hosts override + iptables 允许直连.

详见 `openspec/archive/<date>-m-host-credentials-share/proposal.md`
D10 amendment 段.

## 3a. D7 边界提醒 (原 §3, 仍生效)

owner 在主 ccanywhere session 内跑的 cc **不**经代理 — owner 直接
用 mac Keychain / `~/.claude/.credentials.json` 走 api.anthropic.com。

### 3.1 quota 共享警示

代理 "剩 80%" 是 ccanywhere 账本视角；Anthropic 真实 quota 跟
owner 自己用量**共享同一 subscription**。代理看不到 owner 直连消
耗，故代理余额 vs 真实余额可能错位。upstream 返 429 verbatim
forward，按 owner 自己上 Anthropic dashboard 排查使用比例。

代理**不**做自动告警 (避免依赖 Anthropic dashboard API)。

### 3.2 owner 真凭据 surface

owner 真凭据存在两处 surface (vs 改造前只在 1 处)：

1. macOS Keychain (原有，加密 + OS 级保护)
2. `~/.config/ccanywhere/anthropic-credentials.json` (mode 0600，
   **不加密**) + 代理进程内存

第 2 处是 Phase 1 新增攻击面。mitigation: 代理独立进程 (D1，blast
radius 限制) + 日志强制脱敏 (D4，启动 self-test failsafe) + 文件
mode 0600 启动校验 (D5)。

## 4. 手动 verify

```bash
./scripts/proxy-manual-verify.sh           # 跑完 kill proxy
./scripts/proxy-manual-verify.sh --keep    # 保留 proxy 后续 dogfood
```

脚本流程：

1. preflight: 检查 dist/cli.js + anthropic-credentials.json +
   users.json 三个文件齐全
2. 起 proxy in background + `curl /healthz` 验证存活
3. 读 `~/.config/ccanywhere/proxy-token-secret` (代理 issue 用)，
   颁发 owner id 的 5 分钟 bearer
4. `ANTHROPIC_BASE_URL=http://127.0.0.1:62276 ANTHROPIC_AUTH_TOKEN=<bearer>
   claude --print "OK"` 跑通
5. grep proxy log 验证 bearer 没漏 (D4 redact 兜底验证)

每次 schema bump / proxy 升级后跑一次。

## 5. 升级流程

```bash
git pull && pnpm install && pnpm build:all
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere-proxy
sleep 2 && curl -sf http://127.0.0.1:62276/healthz
```

proxy 改 schema (configDir 新字段) 时按主 server 同样规则：先
docs 同步 + user 显式同步 prod config + kickstart 验证。Phase 1
不动 schema，proxy 字段已带 zod default。

## 6. Phase 2 实际 ship 行为 (D10 反转后)

m-user-shared-container Phase 2 + m-host-credentials-share D10 后,
user 容器内 cc **不**走 proxy:

- session-runtime inject `CLAUDE_CODE_OAUTH_TOKEN=<owner sk-ant-oat>`
  (owner credentials 容器内 setup-token 拿到, 同 device fingerprint)
- 容器内 cc 直连 `api.anthropic.com`, anthropic first-party 接 OAuth
- quota 跟 owner Pro/Max plan 共享 — ccanywhere 不在中间, 看不到
  upstream usage. QuotaWatcher 仅基于 cc 写的 jsonl 算本地账本
  (m-quota-inline D5)

proxy `inline quota check` + `proxy-usage.json` 记账路径**当前未
wire**. 仅当 anthropic 政策回退 / owner 切 Console key 时, 反 wire
proxy 让 user 流量经过, inline quota 重新生效.
