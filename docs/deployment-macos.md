# Deployment — macOS LaunchAgent

主部署文档见 [deployment.md](./deployment.md)。本文档专注 macOS-specific
service install 步骤。Linux 等价路径见
[deployment-linux.md](./deployment-linux.md)。

## 1. LaunchAgent plist

写 `~/Library/LaunchAgents/com.<you>.ccanywhere.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.&lt;you&gt;.ccanywhere</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/&lt;you&gt;/.nvm/versions/node/&lt;version&gt;/bin/node</string>
    <string>/path/to/ccanywhere/dist/cli.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/path/to/ccanywhere</string>

  <key>RunAtLoad</key><true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/&lt;you&gt;/.config/ccanywhere/server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/&lt;you&gt;/.config/ccanywhere/server.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/&lt;you&gt;/.nvm/versions/node/&lt;version&gt;/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
    <key>HOME</key><string>/Users/&lt;you&gt;</string>
  </dict>
</dict>
</plist>
```

**注意**：

- `node` 路径用 `which node` 取绝对路径 (nvm `~/.nvm/.../bin/node` 随版本
  变化;brew Apple Silicon `/opt/homebrew/bin/node` / Intel `/usr/local/bin/node`)
- `WorkingDirectory` 设到 repo 根（让 server 的 `web/dist` 自动解析）
- `claudeBin` 在 config.json 里也写绝对路径 — LaunchAgent PATH 默认是
  `/usr/bin:/bin:/usr/sbin:/sbin`，**不含** `~/.local/bin`

## 2. 加载 / 重启 / 卸载

加载：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<you>.ccanywhere.plist
launchctl print gui/$(id -u)/com.<you>.ccanywhere | head -10
# 应该看到 state = running
```

重启（应用 config / 重 build 后）：

```bash
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere
```

卸载：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.<you>.ccanywhere.plist
```

## 3. macOS-specific 排错

| 现象 | 可能原因 | 解决 |
|------|---------|------|
| 服务启动不起来,`launchctl print` 显示 last exit code 非 0 | node 路径错 (nvm 切换版本后 plist 未更新) | 修改 plist `ProgramArguments[0]` 用 `which node` 的当前绝对路径 |
| 服务能跑但 spawn cc 立即 dead | `claudeBin` 相对路径,LaunchAgent PATH 不含 `~/.local/bin` | config.json `claudeBin` 改成绝对路径,kickstart 重启 |
| `acme.sh --issue` 卡在 "Verifying" | DNS 未生效或 TXT 记录写错 | `dig +short TXT _acme-challenge.cc.<domain>` 验证;确认 DNS-01 凭证是否已 export |
| 续签 timer 运行了但 reverse proxy 未拿到新证书 | `reloadcmd` 静默失败 (sudoers NOPASSWD 未配,或 reload 命令路径不对) | `tail ~/.config/ccanywhere/cert-renew.log` 查看错误;`--reloadcmd` 填写 reverse proxy 实际 reload 命令 |
| frpc 重启后 proxy already exists 一直在 retry | frps 旧 connection 还未超时清理 | 等 60 秒,或在 frps 端踢出旧 client |

证书自动续签 timer 模板见 `examples/launchd/com.example.cc-cert-renew.plist`。
