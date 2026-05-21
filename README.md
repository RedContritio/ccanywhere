# ccanywhere

> 在任何屏幕上，继续你的 cc。  
> Continue your cc on any screen.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen.svg)](package.json)
[![CI](https://github.com/RedContritio/ccanywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/RedContritio/ccanywhere/actions/workflows/ci.yml)

把本地 [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) 的 TUI 通过 web 暴露成可远程访问的入口。

```
browser  ──https──▶  HTTPS frontend (cc.example.com)  ──HTTP──▶  ccanywhere
                    reverse proxy + TLS 终结                127.0.0.1:8081
                                                                  │
                                                                  └─ spawns claude (PTY)
                                                                     继承 ~/.claude 的登录态
```

ccanywhere 自身 listen `127.0.0.1:8081` (HTTP, internal-only)。本机自测
访问 `http://localhost:8081` 即可 (WebAuthn 对 localhost 例外); 远程访问
加一层 HTTPS frontend (reverse-proxy + TLS),见下文 Step 6。

## Prerequisites

**核心 (本机运行所需)**:

- **macOS / Linux** — author 在 macOS 上 daily-driver,Linux 使用 systemd
  等价路径。Windows untested (理论上 `node-pty` ConPTY 可运行,但
  LaunchAgent / shared-container docker desktop windows 未适配)
- **Node.js >= 22**
- **pnpm 11+**(项目用 workspaces;`pnpm-workspace.yaml` 定义 root +
  `web/` 两个 package)
- **已登录的 Claude Code** — 本机 `claude /login` 已经登过(ccanywhere
  spawn 的 cc 子进程继承 `~/.claude/` 登录态)

**远程访问需要**(本机自测可跳过,Step 6 再配置):

- **HTTPS frontend**(reverse-proxy + TLS 终结):caddy / nginx / frp /
  Cloudflare Tunnel / Tailscale 都可,Step 6 给 caddy 主流程 + frp 给
  NAT 后无公网 IP 的场景
- **域名 + DNS**:把 `cc.example.com` A 记录指到 mac 公网 IP(或
  tunnel 入口)。caddy 自动申 cert 需要 DNS 已生效

## 跟同类的差异

ccanywhere 解决一个具体场景:**用完全自己可控的方式远程使用 cc** ——
源代码 / 工作目录 / 凭据 / 流量出口全留在你自己的机器,web 暴露层 +
TLS + 认证都自托管,不依赖第三方 cloud / IdP。

| 方案 | 上手 | 安全模型 | 中转层 / 代码所在 | 与 cc 的契合度 |
|---|---|---|---|---|
| [Claude Code on the web (官方)](https://code.claude.com/docs/en/claude-code-on-the-web) | 最快 | Anthropic 账号 + GitHub OAuth | Anthropic cloud sandbox (repo 要 clone 上去) | 100% (官方;cc 在 cloud 运行) |
| [Claude Code Remote Control (官方)](https://code.claude.com/docs/en/remote-control) | 最快 | claude.ai full-scope OAuth | cc 在本机运行, sync 流量经 Anthropic API | 100% (官方;UI 是 claude.ai/code) |
| [ttyd](https://github.com/tsl0922/ttyd) | 最快 | basic auth, HTTPS 自配 | 全部自己机器 | 通用 TTY,不针对 cc 的 PTY 生命周期 / 重连 / busy-idle |
| Tailscale + SSH | 中 | 网络层 (WireGuard) | 全部自己机器 | 私网方案,每个设备需要安装 client;浏览器直连不行 |
| VSCode tunnel | 快 | GitHub 账号 | 自己机器 + MS 中转 | 适合 VSCode workflow,不直接接入 cc 的 TUI 状态机 |
| **ccanywhere** | 中 | WebAuthn 平台认证器 + 终端 approve | 全链路自托管 | cc 专用:PTY 持久化 / 心跳 / 桌面通知 / busy-idle 状态 |

最值得说清的两条取舍:

- **vs Claude Code on the web**: 官方 web 体验最流畅,但 repo 要 clone
  到 Anthropic sandbox,文件 / `.env` / 私 token 不在本机进程的可见
  范围。ccanywhere 反过来——cc 进程就在你机器上,读的就是本地
  working tree。
- **vs Claude Code Remote Control**: 功能上与 ccanywhere 最接近——
  cc 都在本机运行,只是 UI 远程。差别在"中转层在哪":Remote Control
  消息流经 Anthropic API (官方原话: "All traffic travels through the
  Anthropic API"),依赖 claude.ai full-scope OAuth + organization
  toggle;ccanywhere 中转层在本机运行 (fastify + WebSocket),不经第
  三方,WebAuthn pairing 不需要 cloud IdP。

## 安全模型

- **WebAuthn pairing**: 浏览器第一次访问触发平台认证器 (Touch ID / Face ID
  / 指纹),mac 终端 `ccanywhere approve` 显式确认配对 — 未批准的设备无法
  访问。撤销:`ccanywhere revoke <device-id>`。
- **单用户单服务**: 不做 multi-tenant。owner + 可选 limited user (通过 CLI
  `ccanywhere users add` 颁发 token,配额隔离)。
- **不污染 cc 配置**: spawn cc 时直接继承 `~/.claude/`,不写 user 私域;
  hook 是 opt-in (见 `docs/hooks.md`)。
- **TLS 终结在 mac 本机**: cert 由本机 HTTPS frontend (caddy / acme.sh)
  维护;如果使用 tunnel (frp 等) 也建议 TLS 终结在 mac 端,tunnel server
  不持有 key。

## Quick start (single host)

下文 `ccanywhere` CLI 等价于 `node <repo>/dist/cli.js`。Build 后把
`dist/cli.js` 加到 PATH 最方便(下面 Step 1 末尾给一个 symlink 写法)。

### 1. 安装依赖 + 构建 + CLI 入 PATH

```bash
pnpm install
pnpm build:all     # 构建 server (dist/) + 前端 (web/dist/)

# CLI 入 PATH (替换 <repo> 为本仓库绝对路径)
sudo ln -s <repo>/dist/cli.js /usr/local/bin/ccanywhere
sudo chmod +x /usr/local/bin/ccanywhere
ccanywhere --help                # 验证
```

### 2. 写 config

复制模板:

```bash
mkdir -p ~/.config/ccanywhere
cp examples/config.json ~/.config/ccanywhere/config.json
chmod 600 ~/.config/ccanywhere/config.json
```

编辑 `~/.config/ccanywhere/config.json`(把模板里所有 `<you>` 占位
替换为你的 mac 用户名):

- `workspace`:每个 user 的项目沙盒父目录(绝对路径)。每个 user
  自动得到 `<workspace>/<username>/` 作 cwd 根,owner 默认 username
  是 `owner`,所以 owner 的项目落在 `<workspace>/owner/`。**required**
- `webOrigin`:web 实际访问的 URL。本机自测填 `http://localhost:8081`
  (WebAuthn spec 对 localhost 例外,可跳过 TLS);远程访问后改成
  `https://cc.example.com`。**改这一项会让所有已配对设备失效**,
  需要重新 pair
- `claudeBin`:`claude` CLI 的**绝对路径**(如 `/Users/<you>/.local/bin/
  claude`)。LaunchAgent 下 PATH 不一定含 `~/.local/bin`,写绝对路径
  最稳

**可选** — 把 owner 项目根指向已有 repo 目录(而非新建 `<workspace>/
owner/`):

```json
{
  "workspace": "/Users/<you>/ccanywhere-workspace",
  "users": {
    "owner": { "workspace": "/Users/<you>/Projects" }
  }
}
```

不写 `users.owner.workspace` 时启动会打 warning 提示这个 override
可用,但不影响运行。多 user 场景见 [`docs/deployment.md`](docs/deployment.md) §7。

### 3. 启动 (foreground 试运行)

先 foreground 运行,验证服务能启动 + 浏览器能配对:

```bash
ccanywhere                                # 默认 = ccanywhere serve
# 另开 terminal:
curl -sf http://127.0.0.1:8081/healthz    # 应返 {"ok":true,...}
```

Step 5 完成浏览器配对、验证 cc session 能启动之后,再考虑 Step 4
(LaunchAgent 持久化) 和 Step 6 (远程访问)。本机自测阶段用 `Ctrl-C`
随时启停即可。

### 4. 守护进程(可选)

让 ccanywhere 开机自启 + 崩溃自动重启。

- **macOS**: LaunchAgent (`~/Library/LaunchAgents/com.<you>.ccanywhere.plist`)
  — 完整 plist 模板见 [`docs/deployment-macos.md`](docs/deployment-macos.md)
- **Linux**: systemd user unit (`~/.config/systemd/user/ccanywhere.service`)
  — 模板见 [`docs/deployment-linux.md`](docs/deployment-linux.md)

任一方式安装好后:

```bash
# macOS
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.ccanywhere.plist
# Linux
systemctl --user enable --now ccanywhere.service

curl -sf http://127.0.0.1:8081/healthz                       # 应返 {"ok":true,...}
```

### 5. 浏览器配对 + 访问

第一次访问 `http://localhost:8081/login`(或远程访问场景下的
`https://<webOrigin host>/login`):

1. 浏览器:输入设备名(如 "iPhone")→ 点「申请配对」→ 触发平台认证器
   (Touch ID / Face ID / 指纹)。
2. mac 终端:运行 `ccanywhere approve`,列出 pending → 选择 → 确认。
3. 浏览器自动跳到 workspace。

之后再访问只需点「用本机生物识别登入」,不需要再 approve。撤销设备:
`ccanywhere revoke <device-id>`(先 `ccanywhere devices` 找 id)。

### 6. 远程访问(可选)

本机自测通过后,想从外面手机 / 笔记本访问就接一层 HTTPS frontend。
**修改 `webOrigin` 会让 Step 5 配过的设备全部失效,需要重新 pair**——
建议确定好最终 origin 一次配置到位。

两类典型场景:

#### A. mac 有公网 IP / 路由器能 NAT 转发 — caddy

最简单的方案。caddy 自动申 + 续 Let's Encrypt 证书。

```bash
# 先确保 cc.example.com 的 DNS A 记录已指到 mac 公网 IP
brew install caddy
sudo tee /opt/homebrew/etc/Caddyfile >/dev/null <<EOF
cc.example.com {
    reverse_proxy 127.0.0.1:8081
}
EOF
brew services restart caddy
curl -sf https://cc.example.com/healthz                      # 应返 {"ok":true,...}
```

config 里把 `webOrigin` 改成 `https://cc.example.com` + 重启 ccanywhere。

#### B. mac 在 NAT 后 / 无公网 IP — frp tunnel

家庭网络、运营商 NAT 等场景。租一台有公网 IP 的小机器运行 frps,mac
运行 frpc 把流量拉过去 + TLS 终结在 mac 端 (tunnel server 不持
key)。

```bash
# mac 本机:
brew install frpc
# 拿到 cc.example.com 的证书(用 scripts/cert-issue.sh DNS-01,或自带)
# 复制并编辑 examples/frpc.toml,inline 注释指引每个字段
cp examples/frpc.toml ~/.config/ccanywhere/frpc.toml
# 启动 frpc(LaunchAgent 模板见 examples/launchd/)
```

`examples/frpc.toml` 用 `https + https2http` plugin(frpc 端 TLS
终结);注释里附 plain TCP fallback。frp 官方文档:
<https://github.com/fatedier/frp>。

#### 其他选项

- **nginx / 其它 reverse proxy** + `scripts/cert-issue.sh`(Let's
  Encrypt DNS-01,适合 443 不能直连场景或想用 wildcard cert)
- **Tailscale**:私网 + magicDNS,把 `100.x.x.x:8081` 当 origin
  (cc 浏览器侧需要 Tailscale client),参考 Tailscale 官方文档
- **Cloudflare Tunnel**:`cloudflared tunnel run --url
  http://127.0.0.1:8081`,cert 由 Cloudflare 边缘维护

## 关键文件

项目用 pnpm workspaces:root 是 server + CLI (`src/`),`web/` 是 React
前端子 workspace。`pnpm-workspace.yaml` 定义,运行 web 命令用过滤前缀
`pnpm -F ccanywhere-web ...`(例:`pnpm -F ccanywhere-web build`)。

| 文件 | 用途 |
|------|------|
| `src/cli.ts` | 服务端入口，读取 config 启动 fastify |
| `src/server/server.ts` | REST + WS + SPA 单进程 |
| `src/session/manager.ts` | PTY lifecycle、scrollback、deletedAt + GC |
| `src/ws/server.ts` | WebSocket 协议、leading-edge debounce、心跳 |
| `web/src/` | React 前端：登录、workspace、xterm 集成 |
| `examples/config.json` | ccanywhere 配置模板 |
| `examples/frpc.toml` | frpc 配置模板（仅 frp 隧道路径用;https + https2http plugin） |
| `examples/launchd/` | macOS LaunchAgent plist 模板（证书自动续签 timer） |
| `scripts/cert-issue.sh` | 一键 Let's Encrypt 申请脚本，**author 本机 setup**（macOS launchd + frpc + 腾讯云 DNS）;按顶部注释 fork 修改 3 行可替换其他 DNS / reload 命令 |

## 测试

```bash
pnpm test                          # 服务端 vitest 单测
pnpm -F ccanywhere-web test        # 前端 vitest 单测
pnpm -F ccanywhere-web e2e         # 前端 playwright e2e (需 ccanywhere 在运行)
```

playwright e2e 是 **self-hosted only** — 经 prod webOrigin + 通过 loopback
internal RPC mint token,GitHub Actions 用 `vars.E2E_ENABLED` gate +
self-hosted runner labels `[self-hosted, macOS, ccanywhere]`,外部 fork
默认不运行,见 `.github/workflows/e2e.yml`。

## 文档

- [`docs/deployment.md`](docs/deployment.md) — 部署总览:config、build、隧道、证书、排错
- [`docs/deployment-macos.md`](docs/deployment-macos.md) — macOS LaunchAgent 模板 + 安装步骤
- [`docs/deployment-linux.md`](docs/deployment-linux.md) — Linux systemd unit 模板 + 安装步骤
- [`docs/hooks.md`](docs/hooks.md) — opt-in 把 hook 段贴进 `~/.claude/settings.json`，
  让 web 端的 session 状态徽标实时反映 cc 的 busy/idle

## 设计原则

- **单用户单服务**：不做 multi-tenant、不做协同。
- **不污染 user 配置**：spawn cc 时直接继承 `~/.claude/`，hook 是 opt-in。
- **明确退出码**：1=fatal、2=config 错误、3+=具体原因。

## Contributing

见 [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup /
commit 约定。

## Security

安全漏洞通过 GitHub Private Security Advisory 报告,见 [SECURITY.md](./SECURITY.md)。

## License

Apache-2.0. See [LICENSE](./LICENSE).
