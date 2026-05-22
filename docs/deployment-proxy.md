# Deployment — anthropic 代理

> **Status: DORMANT — 普通部署可跳过这整篇文档**
>
> proxy 子进程由 ccanywhere main 自动 spawn,缺 credentials 时以
> 503/degraded mode 启动(不 crash-loop),所有 forward 路由返 503。
> **当前 user 流量不经 proxy**——anthropic 2026-02 起禁止第三方应用
> 通过 `Authorization: Bearer` 转发 OAuth subscription token,user
> 容器内 cc 改用 `CLAUDE_CODE_OAUTH_TOKEN` env 直连 anthropic。
>
> 只在以下情形需要继续读:
> 1. 你 hacking on proxy 子进程本身
> 2. owner 切到 Console API key (`sk-ant-api03-...` 按 token 计费)
>    且想用 proxy 路径(anthropic 仍允许 `X-Api-Key` 转发)
> 3. anthropic 政策回退时反向 wire user 流量

ccanywhere main process 启动时通过 `child_process.spawn` 起的子进程
`ccanywhere proxy serve`,listen `config.proxy.port` (default 8082) on
`config.proxy.bindHost` (default 127.0.0.1)。

proxy 仍 listen 作为 future fallback (政策回退或 owner 切换到 Console API
key 时反向 wire)。当前靠 `scripts/proxy-manual-verify.sh` + 单元测试
验证。

主部署文档见 [deployment.md](./deployment.md)。

## 1. owner 真凭据

两种 auth 二选一:

**a. Console API key(按 token 计费)**

```bash
read -s ANT_KEY  # paste sk-ant-...
printf '{"apiKey":"%s"}\n' "$ANT_KEY" > ~/.config/ccanywhere/anthropic-credentials.json
chmod 600 ~/.config/ccanywhere/anthropic-credentials.json
unset ANT_KEY
```

proxy 转发用 `X-Api-Key` header,通过 Console billing。

**b. Claude Code subscription OAuth(复用 Pro/Max plan,推荐)**

先在 owner mac 本机 (与 claude 已登录的 user 一致) 运行:

```bash
claude setup-token   # 通过 browser OAuth, 1 年期 token 打印到 terminal
```

然后:

```bash
read -s OAUTH        # paste sk-ant-oat-...
printf '{"oauthToken":"%s"}\n' "$OAUTH" > ~/.config/ccanywhere/anthropic-credentials.json
chmod 600 ~/.config/ccanywhere/anthropic-credentials.json
unset OAUTH
```

proxy 转发用 `Authorization: Bearer`,通过 owner Claude Pro/Max
subscription quota,**不**消耗 Console credit。Token 1 年期,到期
重新运行 `claude setup-token`。

**两个都配** 时 proxy 优先用 `oauthToken` (subscription) → 适合
admin 偶尔切回 apiKey 调试时。

- 文件不存在 → 代理以 **503 模式**启动(admin 可以晚配,不
  crash-loop),所有 forward 路由返 503
- mode 不是 0600 → 启动 fatal(拒绝读其他 user 可读的 key 文件)
- malformed JSON / `apiKey` + `oauthToken` 都缺 → 启动 fatal

**任何 commit 进 git 前**检查这个文件没被加进,避免泄漏。

## 2. 启动方式:由 ccanywhere main 自动 spawn

ccanywhere main process 启动时通过 `child_process.spawn` 启动 proxy 子
进程:

- **独立 OS process** — credentials 文件 read 仅在 proxy 子进程,main
  process RCE 不直接拿到 owner key
- **lifecycle 绑定** — main service unit (macOS LaunchAgent / Linux
  systemd) 一个即可;main 启动 = proxy 启动,main 停止 = proxy 停止
- **mini supervisor** — proxy 子进程 crash 时按退避序列重启
  (1s/2s/5s/10s/30s);60s 窗口内连续 5 次 crash 触发 give-up,main
  继续运行 (owner host 路径仍能用)
- **log 独立** — stdio 重定向到 `<configDir>/proxy.log` (mode 0600)
- **shutdown 顺序** — main 收到 SIGTERM → 先 stop containers → SIGTERM
  proxy 子进程 → 5s grace → SIGKILL → main exit

用户无需任何 LaunchAgent 安装步骤。第一节配置好 credentials 文件 +
reload main service (reload 命令见 [deployment.md](./deployment.md) §3) 后
proxy 自动启动:

```bash
curl -sf http://127.0.0.1:8082/healthz
# 应返 {"ok":true,"mode":"ready"} (有 credentials)
# 或   {"ok":true,"mode":"degraded"} (credentials 缺失, 仍接 HEAD/healthz
# 但 forward 路由都返 503/404)
```

debug proxy 子进程:

```bash
pgrep -fa 'proxy serve'           # 找 PID
tail -f ~/.config/ccanywhere/proxy.log
```

## 3. 当前 user 流量不经 proxy

Anthropic 2026-02 起明确禁止第三方应用通过 `Authorization: Bearer`
转发 OAuth subscription token (cc binary 自身仍可采用 first-party)。
当前 user shared-container 流量直连 `api.anthropic.com`:

- 容器内 cc 用 `CLAUDE_CODE_OAUTH_TOKEN` env(容器内 issued via
  `claude setup-token`,容器内 use,同 device fingerprint)直连
- session-runtime overlay inject env

quota 与 owner Pro/Max plan 共享 — ccanywhere 不在中间,看不到
upstream usage。QuotaWatcher 仅基于 cc 写的 jsonl 计算本地账本。

proxy 仍 listen 作 future fallback:

- anthropic 改回允许第三方 proxy → 反向 wire 即可
- owner 切换到 Console API key (`sk-ant-api03-...` 烧 credit) → proxy
  forward `X-Api-Key` 通过 Console billing,此路径 anthropic 仍允许

## 3a. owner 主 session 不经代理

owner 在主 ccanywhere session 内运行的 cc **不**经代理 — owner 直接
用 mac Keychain / `~/.claude/.credentials.json` 连接 `api.anthropic.com`。

### 3.1 quota 共享警示

代理 "剩 80%" 是 ccanywhere 账本视角;Anthropic 真实 quota 与
owner 自己用量**共享同一 subscription**。代理看不到 owner 直连消
耗,故代理余额 vs 真实余额可能错位。upstream 返回 429 verbatim
forward,需由 owner 自己上 Anthropic dashboard 排查使用比例。

代理**不**做自动告警(避免依赖 Anthropic dashboard API)。

### 3.2 owner 真凭据 surface

owner 真凭据存在两处 surface(vs 仅 macOS Keychain 多一处):

1. macOS Keychain(原有,加密 + OS 级保护)
2. `~/.config/ccanywhere/anthropic-credentials.json`(mode 0600,
   **不加密**) + 代理进程内存

第 2 处是新增攻击面。mitigation:代理独立进程(blast radius 限制)
+ 日志强制脱敏(启动 self-test failsafe)+ 文件 mode 0600 启动校验。

## 4. 手动 verify

```bash
./scripts/proxy-manual-verify.sh           # 运行完成后 kill proxy
./scripts/proxy-manual-verify.sh --keep    # 保留 proxy 后续 dogfood
```

脚本流程:

1. preflight:检查 `dist/cli.js` + `anthropic-credentials.json` +
   `users.json` 三个文件齐全
2. 在后台启动 proxy + `curl /healthz` 验证存活
3. 读 `~/.config/ccanywhere/proxy-token-secret`(代理 issue 用),
   颁发 owner id 的 5 分钟 bearer
4. `ANTHROPIC_BASE_URL=http://127.0.0.1:8082 ANTHROPIC_AUTH_TOKEN=<bearer>
   claude --print "OK"` 验证执行通过
5. grep proxy log 验证 bearer 未泄漏 (redact 兜底验证)

每次 schema bump / proxy 升级后跑一次。

## 5. 升级流程

```bash
git pull && pnpm install && pnpm build:all
<reload-service>           # main service reload, 见 deployment.md §3
sleep 2 && curl -sf http://127.0.0.1:8082/healthz
```

proxy 修改 schema (`configDir` 新字段) 时按主 server 同样规则:先
docs 同步 + user 显式同步 prod config + kickstart 验证。proxy 字段
带 zod default 时 existing prod config 零改动可加载。
