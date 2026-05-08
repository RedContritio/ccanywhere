# ccanywhere

把本地 [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) 的
TUI 通过 web 暴露成可远程访问的入口。手机浏览器登录后能直接接入本机的 cc，
看 TUI、敲命令、断网自动重连，状态实时同步。

```
browser  ──https──▶  frps  ──tunnel──▶  frpc on host  ──HTTP──▶  ccanywhere
                  recoco.xyz                        127.0.0.1:62275
                                                      │
                                                      └─ spawns claude (PTY)
                                                         继承 ~/.claude 的登录态
```

## 状态

M1–M7 全部就绪：

- **服务端**：fastify + WebSocket，Idempotency-Key、softly-delete + GC、
  WS 心跳；148 个测试覆盖。
- **前端**：React 18 + Vite 5，xterm.js 终端，主题 auto/light/dark，
  移动端虚拟工具栏，桌面通知（busy → idle 触发）。
- **frp**：默认端口 62275（一次性随机选定固化），cc spawn 不污染 user 的
  `~/.claude/` 让网页登录态与本机一致。

## Quick start (macOS, single host)

### 1. 装依赖 + 构建

```bash
pnpm install
pnpm build:all     # 构建 server (dist/) + 前端 (web/dist/)
```

### 2. 写 config

复制模板：

```bash
mkdir -p ~/.config/ccanywhere
cp examples/config.json ~/.config/ccanywhere/config.json
chmod 600 ~/.config/ccanywhere/config.json
```

编辑 `~/.config/ccanywhere/config.json`：

- `webOrigin` 改成 web 实际访问的 URL（如 `https://ccanywhere.example.com`）。
  WebAuthn `rpID` 由其 hostname 派生；改 `webOrigin` 后所有已配对设备需重新 pair
- `claudeBin` 写绝对路径（如 `/Users/<you>/.local/bin/claude`），LaunchAgent
  下的 PATH 不一定含 `~/.local/bin`
- `projectsRoot` 改成你想作为"项目集合根"的目录（绝对路径，如 `/Users/<you>/Projects`）。其下的直接子目录都会被自动列为可选项目，新建 / 隐藏可在 web 端 NewSessionDialog 里完成

### 3. 跑起 ccanywhere（LaunchAgent）

参考 `docs/deployment.md` 写一个 `~/Library/LaunchAgents/com.<you>.ccanywhere.plist`，
然后：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.ccanywhere.plist
launchctl print gui/$(id -u)/com.<you>.ccanywhere | head    # 看 state=running
```

### 4. 配 frpc

复制 `examples/frpc.toml` 到你的 frpc 工作目录（含 ssh / 其它 proxy 时直接
追加 `[[proxies]]` 段），改 `serverAddr` / `auth.token` 为你的 frps 信息，
重启 frpc。

详细配置（含 https2http 拓扑）见 `docs/deployment.md`。

### 5. 浏览器配对 + 访问

第一次访问 `https://<webOrigin host>/login`：

1. 浏览器：输入设备名（如 "iPhone"）→ 点「申请配对」→ 触发平台认证器
   （Touch ID / Face ID / 指纹）。
2. mac 终端：跑 `ccanywhere approve`，列出 pending → 选择 → 确认。
3. 浏览器自动跳到 workspace。

之后再访问只需点「用本机生物识别登入」，不需要再 approve。撤销设备：
`ccanywhere revoke <device-id>`（先 `ccanywhere devices` 找 id）。

## 关键文件

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
| `openspec/specs/` | 行为契约（人读真相） |
| `openspec/archive/` | 已应用的变更提案历史 |

## 测试

```bash
pnpm test                          # 服务端 113 单测
pnpm -F ccanywhere-web test        # 前端 33 单测
pnpm -F ccanywhere-web e2e         # 前端 4 个 playwright e2e（需 ccanywhere 在跑）
```

## 文档

- [`docs/deployment.md`](docs/deployment.md) — macOS LaunchAgent + frpc + 证书配置
- [`docs/hooks.md`](docs/hooks.md) — opt-in 把 hook 段贴进 `~/.claude/settings.json`，
  让 web 端的 session 状态徽标实时反映 cc 的 busy/idle

## 设计原则

- **单用户单服务**：不做 multi-tenant、不做协同。
- **契约优先**：行为先写 `openspec/specs/`，跨契约改动走 `openspec/changes/`
  提案 → 实现 → 归档流程。
- **不污染 user 配置**：spawn cc 时直接继承 `~/.claude/`，hook 是 opt-in。
- **明确退出码**：1=fatal、2=config 错误、3+=具体原因。

## License

（待补）
