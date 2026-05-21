# ccanywhere

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen.svg)](package.json)
[![CI](https://github.com/RedContritio/ccanywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/RedContritio/ccanywhere/actions/workflows/ci.yml)

把本地 [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) 的
TUI 通过 web 暴露成可远程访问的入口。手机浏览器登录后能直接接入本机的 cc,
看 TUI、敲命令、断网自动重连,状态实时同步。

```
browser  ──https──▶  HTTPS frontend (cc.example.com)  ──HTTP──▶  ccanywhere
                    reverse proxy + TLS 终结                127.0.0.1:8081
                                                                  │
                                                                  └─ spawns claude (PTY)
                                                                     继承 ~/.claude 的登录态
```

ccanywhere 自身 listen `127.0.0.1:8081`(HTTP, internal-only)。你需要一个
HTTPS frontend 把公网 HTTPS 流量 reverse-proxy 到 8081 + 处理 TLS。最简
方案是 [caddy](https://caddyserver.com/)(auto-cert)。如果 mac 在 NAT
后无公网 IP,自己另起 tunnel(frp / Tailscale / Cloudflare Tunnel 等);
`examples/frpc.toml` 提供 frp 模板作参考。

## Prerequisites

- **macOS only** — LaunchAgent + `node-pty` 原生模块(目前没有 Linux /
  Windows 移植)
- **Node.js >= 20**
- **pnpm 11+**(项目用 workspaces;`pnpm-workspace.yaml` 定义 root +
  `web/` 两个 package)
- **HTTPS frontend** + **公网入口**:推荐 caddy(auto-cert,本节后续
  指引);其他选项见 `docs/`。如果 mac 没公网 IP,自己另起 tunnel。
- **域名 + DNS**:把 `cc.example.com` A 记录指到 mac 公网 IP(或 tunnel
  entry)。caddy 申 cert 需要 DNS 已生效。

## 跟同类的差异

ccanywhere 解决一个具体场景:**你在外面想接着用本机已经登录的 cc 会话**。

| 方案 | 上手 | 安全模型 | 跟 cc 的契合度 |
|---|---|---|---|
| [ttyd](https://github.com/tsl0922/ttyd) | 最快 | basic auth, HTTPS 自配 | 通用 TTY,不针对 cc 的 PTY 生命周期 / 重连 / busy-idle |
| Tailscale + SSH | 中 | 网络层 (WireGuard) | 私网方案,每设备装 client;浏览器直连不行 |
| VSCode tunnel | 快 | GitHub 账号 | 适合 VSCode workflow,不直接走 cc 的 TUI 状态机 |
| **ccanywhere** | 中 | WebAuthn 平台认证器 + mac 终端 approve | cc 专用:PTY 持久化 / 心跳 / 桌面通知 / busy-idle 状态 |

## 安全模型

- **WebAuthn pairing**: 浏览器第一次访问触发平台认证器 (Touch ID / Face ID
  / 指纹),mac 终端 `ccanywhere approve` 显式确认配对 — 未批准的设备无法
  访问。撤销:`ccanywhere revoke <device-id>`。
- **单用户单服务**: 不做 multi-tenant。owner + 可选 limited user (通过 CLI
  `ccanywhere users add` 颁发 token,配额隔离)。
- **不污染 cc 配置**: spawn cc 时直接继承 `~/.claude/`,不写 user 私域;
  hook 是 opt-in (见 `docs/hooks.md`)。
- **TLS 终结在 mac 本机**: cert 由本机 HTTPS frontend (caddy / acme.sh)
  维护;如果走 tunnel(frp 等)也建议 TLS 终结在 mac 端,tunnel server
  不持有 key。

## Quick start (macOS, single host)

下文 `ccanywhere` CLI 等价于 `node <repo>/dist/cli.js`。Build 后把
`dist/cli.js` 加到 PATH 最方便(下面 Step 1 末尾给一个 symlink 写法)。

### 1. 装依赖 + 构建 + CLI 入 PATH

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

- `webOrigin` 改成 web 实际访问的 URL(如 `https://cc.example.com`)。
  WebAuthn `rpID` 由其 hostname 派生;改 `webOrigin` 后所有已配对设备需重新 pair
- `claudeBin` 写绝对路径(如 `/Users/<you>/.local/bin/claude`),LaunchAgent
  下的 PATH 不一定含 `~/.local/bin`
- `projectsRoot` 改成你想作为"项目集合根"的目录(绝对路径,如
  `/Users/<you>/Projects`)。其下的直接子目录都会被自动列为可选项目,
  新建 / 隐藏可在 web 端 NewSessionDialog 里完成
- `guestProjectsRoot`(模板已默认 `/Users/<you>/.ccanywhere-guests`)是
  limited user 项目沙盒父目录。**必填**,即便只跑 single-owner 也得
  保留,启动会 `mkdir -p` (mode 0700);**MUST NOT** 跟 `projectsRoot`
  相同或互为父子(详见 `docs/deployment.md`)

### 3. 跑起 ccanywhere(LaunchAgent)

参考 `docs/deployment.md` 写一个
`~/Library/LaunchAgents/com.<you>.ccanywhere.plist`,然后:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.ccanywhere.plist
launchctl print gui/$(id -u)/com.<you>.ccanywhere | head    # 看 state=running
curl -sf http://127.0.0.1:8081/healthz                       # 应返 {"ok":true,...}
```

### 4. 配 HTTPS frontend(推荐 caddy)

先确保 `cc.example.com` 的 DNS A 记录已指到 mac 公网 IP(或 tunnel 入口)。

```bash
brew install caddy
sudo tee /opt/homebrew/etc/Caddyfile >/dev/null <<EOF
cc.example.com {
    reverse_proxy 127.0.0.1:8081
}
EOF
brew services restart caddy
curl -sf https://cc.example.com/healthz                      # 应返 {"ok":true,...}
```

Caddy 自动申请 + 续 Let's Encrypt 证书(443 端口必须公网可达)。

**其他选项**:

- **nginx / 其它 reverse proxy** + `scripts/cert-issue.sh`(Let's Encrypt
  DNS-01,适合 443 不能直连场景或想用 wildcard cert)。脚本内含使用说明,
  默认 DNS provider 是腾讯云作 example。
- **frp tunnel**(mac 在 NAT 后):`examples/frpc.toml` 含详细 inline
  注释。frp 官方文档:<https://github.com/fatedier/frp>。
- **Tailscale / Cloudflare Tunnel**:参考各自官方文档,reverse-proxy 到
  `127.0.0.1:8081`。

### 5. 浏览器配对 + 访问

第一次访问 `https://<webOrigin host>/login`:

1. 浏览器:输入设备名(如 "iPhone")→ 点「申请配对」→ 触发平台认证器
   (Touch ID / Face ID / 指纹)。
2. mac 终端:跑 `ccanywhere approve`,列出 pending → 选择 → 确认。
3. 浏览器自动跳到 workspace。

之后再访问只需点「用本机生物识别登入」,不需要再 approve。撤销设备:
`ccanywhere revoke <device-id>`(先 `ccanywhere devices` 找 id)。

## 关键文件

项目用 pnpm workspaces:root 是 server + CLI (`src/`),`web/` 是 React
前端子 workspace。`pnpm-workspace.yaml` 定义,跑 web 命令用过滤前缀
`pnpm -F ccanywhere-web ...`(例:`pnpm -F ccanywhere-web build`)。

| 文件 | 用途 |
|------|------|
| `src/cli.ts` | 服务端入口，读 config 启动 fastify |
| `src/server/server.ts` | REST + WS + SPA 单进程 |
| `src/session/manager.ts` | PTY lifecycle、scrollback、deletedAt + GC |
| `src/ws/server.ts` | WebSocket 协议、leading-edge debounce、心跳 |
| `web/src/` | React 前端：登录、workspace、xterm 集成 |
| `examples/config.json` | ccanywhere 配置模板 |
| `examples/frpc.toml` | frpc 配置模板（https + https2http plugin，注释里附 plain TCP fallback） |
| `examples/launchd/` | LaunchAgent / LaunchDaemon plist 模板（含证书自动续签 timer） |
| `scripts/cert-issue.sh` | 一键 Let's Encrypt 申请脚本（DNS-01 via 腾讯云 / 可改其他 DNS） |

## 测试

```bash
pnpm test                          # 服务端 vitest 单测
pnpm -F ccanywhere-web test        # 前端 vitest 单测
pnpm -F ccanywhere-web e2e         # 前端 playwright e2e (需 ccanywhere 在跑)
```

playwright e2e 是 **self-hosted only** — 走 prod webOrigin + 通过 loopback
internal RPC mint token,GitHub Actions 用 `vars.E2E_ENABLED` gate +
self-hosted runner labels `[self-hosted, macOS, ccanywhere]`,外部 fork
默认不跑,见 `.github/workflows/e2e.yml`。

## 文档

- [`docs/deployment.md`](docs/deployment.md) — macOS LaunchAgent + frpc + 证书配置
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
