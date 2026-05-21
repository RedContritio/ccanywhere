# Deployment — Linux systemd

主部署文档见 [deployment.md](./deployment.md)。本文档专注 Linux-specific
service install 步骤。macOS 等价路径见
[deployment-macos.md](./deployment-macos.md)。

> **author 注**：daily-driver 是 macOS,Linux 路径按 standard systemd
> 实践写,未做 long-term dogfood。社区 contributor 跑出问题 → 开 issue
> 反馈。

## 1. systemd user unit

写 `~/.config/systemd/user/ccanywhere.service`：

```ini
[Unit]
Description=ccanywhere — Claude Code remote bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/ccanywhere
ExecStart=/usr/bin/node /path/to/ccanywhere/dist/cli.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:%h/.config/ccanywhere/server.log
StandardError=append:%h/.config/ccanywhere/server.log

[Install]
WantedBy=default.target
```

**注意**：

- `ExecStart` 第一个参数用 `which node` 拿绝对值(nvm / asdf 装的 node
  在 `~/.nvm/versions/node/<v>/bin/node` 或 `~/.asdf/installs/...`)
- `WorkingDirectory` 设到 repo 根（让 server 的 `web/dist` 自动解析）
- `claudeBin` 在 config.json 里也写绝对路径 — systemd PATH 默认 minimal,
  `~/.local/bin` 不一定在
- log 路径 `%h` 是 systemd 自动展开成 `$HOME`,不需要硬写 `/home/<you>`

## 2. 启用 / 重启 / 禁用

启用 + 立即起：

```bash
systemctl --user daemon-reload
systemctl --user enable --now ccanywhere.service
systemctl --user status ccanywhere.service
# 应看到 Active: active (running)
```

重启（应用 config / 重 build 后）：

```bash
systemctl --user restart ccanywhere.service
```

关 + 禁用：

```bash
systemctl --user disable --now ccanywhere.service
```

**让 user units 在 user 不登录时也跑**（开机自启关键）：

```bash
sudo loginctl enable-linger $USER
```

不开 linger 的话 user units 仅在 user 有 active session 时跑,SSH 退出
就停。

## 3. Linux-specific 备注

- **node-pty**: Linux 原生支持(`forkpty(3)`),无需额外依赖
- **shared-container runtime**: docker daemon 直接跑(无需 Docker Desktop
  abstraction),per-user 容器 uid 映射跟 macOS Docker Desktop 不一样,fs
  perm 0700 是真生效的(macOS bind mount 仅 cosmetic)
- **证书续签 timer**: 改用 systemd timer 等价于 launchd
  StartCalendarInterval。在 `~/.config/systemd/user/cc-cert-renew.timer` +
  `.service` 配对写,`systemctl --user enable --now cc-cert-renew.timer`
- **TLS frontend**: caddy / nginx 在 Linux 上是 first-class,推荐路径,
  比 frpc tunnel 简单
