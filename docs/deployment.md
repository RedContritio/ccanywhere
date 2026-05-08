# Deployment

macOS 单机部署 ccanywhere + frpc。Linux 类似（用 systemd 替代 launchd）。

## 前置

- macOS（或 Linux），Node 20+，pnpm
- frpc 装在本机，frps 在远端可达
- cc CLI 装好且 user 已经在本机用 `claude /login` 登过

## 1. 构建

```bash
git clone <your-fork> ccanywhere
cd ccanywhere
pnpm install
pnpm build:all
```

产出：

- `dist/cli.js` — 服务端入口
- `web/dist/` — 前端静态资源（被 fastify-static 服务）

## 2. 配置

```bash
mkdir -p ~/.config/ccanywhere
cp examples/config.json ~/.config/ccanywhere/config.json
chmod 600 ~/.config/ccanywhere/config.json
```

编辑要点：

| 字段 | 说明 |
|------|------|
| `port` | 默认 `62275`（一次性随机选定）。多机部署改成别的 |
| `claudeBin` | 写**绝对路径**。LaunchAgent 的 PATH 不含 `~/.local/bin`，相对名 `claude` 会找不到导致 spawn 立即 dead |
| `tokens[].token` | 用 `openssl rand -hex 32` 生成新值，至少 16 字符 |
| `projects[].cwd` | 暴露给 cc 的项目根，绝对路径 |
| `outputFps` | WS 输出最大帧率，1..240 默认 60。带宽紧张可调到 24 |
| `deletedSessionTtlMs` | 软删除保留时长，默认 600_000（10 分钟）|
| `wsHeartbeat.timeoutMs` | 必须严格大于 `intervalMs`，默认 60000/30000 |

### 关于 `claudeBin` 的坑

```bash
which claude
# /Users/you/.local/bin/claude
```

LaunchAgent / LaunchDaemon 的 PATH 默认是 `/usr/bin:/bin:/usr/sbin:/sbin`，
**不含** `~/.local/bin`。把 `claudeBin` 写绝对路径最稳。

## 3. ccanywhere 作为 LaunchAgent

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

- `node` 路径写**当前 nvm 用的具体版本**——nvm 升级 node 后这条要更新
- `WorkingDirectory` 设到 repo 根（让 server 的 `web/dist` 自动解析）
- log 路径 `~/.config/ccanywhere/server.log` 集中放置

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

## 4. frpc 作为 LaunchDaemon（可选）

如果 frpc 想做开机自启（系统级服务，不依赖用户登录），用 LaunchDaemon：

```xml
<!-- /Library/LaunchDaemons/com.fatedier.frpc.plist (要 sudo 编辑) -->
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fatedier.frpc</string>
  <key>UserName</key><string>&lt;you&gt;</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/frpc</string>
    <string>-c</string>
    <string>/Users/&lt;you&gt;/.config/frp/frpc.toml</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key>
  <string>/Users/&lt;you&gt;/.config/frp/frpc.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/&lt;you&gt;/.config/frp/frpc.log</string>
</dict>
</plist>
```

加载：`sudo launchctl bootstrap system /Library/LaunchDaemons/com.fatedier.frpc.plist`。

**重启 frpc**（应用 frpc.toml 改动）：

```bash
sudo launchctl kickstart -k system/com.fatedier.frpc
```

⚠️ 直接 `kill` 已 launchd 管的进程会触发 KeepAlive，但 SuccessfulExit=false
配下 SIGTERM 让 exit=0 反而**不重启**。规范的方式是 `kickstart -k`。

## 5. frpc 配置

参考 `examples/frpc.toml`。两种拓扑选一种：

### A. plain TCP（最简，HTTP 暴露）

```toml
[[proxies]]
name = "ccanywhere"
type = "tcp"
localIP = "127.0.0.1"
localPort = 62275
remotePort = 62275
```

公网入口：`http://<frps host>:62275/`。**没有 TLS**——只在你信任公网链路或
仅 LAN 用时合适。

### B. https + frpc 端持证书（推荐生产）

frpc 的 `https2http` plugin 在本机终结 TLS：

```toml
[[proxies]]
name = "ccanywhere"
type = "https"
customDomains = ["ccanywhere.example.com"]

[proxies.plugin]
type = "https2http"
localAddr = "127.0.0.1:62275"
crtPath = "/Users/<you>/.config/ccanywhere/certs/ccanywhere.example.com.crt"
keyPath = "/Users/<you>/.config/ccanywhere/certs/ccanywhere.example.com.key"
hostHeaderRewrite = "ccanywhere.example.com"
```

`crtPath` / `keyPath` 用绝对路径（frp **不**展开 `~`）。

frps 端必需：`vhostHTTPSPort = 443`（frps.toml）。证书申请用 acme.sh +
DNS-01 challenge（HTTP-01 不行，因为 ccanywhere 不在公网 80 上）：

```bash
acme.sh --issue --dns dns_cf -d ccanywhere.example.com
acme.sh --install-cert -d ccanywhere.example.com \
  --key-file ~/.config/ccanywhere/certs/ccanywhere.example.com.key \
  --fullchain-file ~/.config/ccanywhere/certs/ccanywhere.example.com.crt \
  --reloadcmd "sudo launchctl kickstart -k system/com.fatedier.frpc"
```

公网入口：`https://ccanywhere.example.com/`。

## 6. 验证

```bash
# 本地
curl http://127.0.0.1:62275/healthz
# {"ok":true}

# 公网
curl http://<frps>:62275/healthz
# {"ok":true}

# 带 token 列项目
curl -H "Authorization: Bearer <你的 token>" http://127.0.0.1:62275/api/projects
```

浏览器：`http://<frps>:62275/login`（或 https 域名）→ 登录 → 创建 session →
xterm 应该立即显示 cc 主界面（已读 user `~/.claude/auth.json`，不要求重登）。

## 7. 排错

| 现象 | 可能原因 | 解决 |
|------|---------|------|
| 浏览器 401 | token 错或 config tokens 列表缺该 token | 检查 `~/.config/ccanywhere/config.json` |
| 创建 session 即 dead | `claudeBin` 找不到（PATH 问题） | 改为绝对路径 |
| 创建 session 后跳到 cc 登录页 | 你跑的是 M5 旧版（CLAUDE_CONFIG_DIR 注入） | `git pull && pnpm build:all && launchctl kickstart -k …` |
| 卡顿明显 | 旧版 100ms trailing-flush | 同上，确认在 M-hook-opt-in 之后的版本 |
| 公网 / 返回 404 envelope | `web/dist/` 不存在 / 路径解析错 | `pnpm build:all` 后重启 |
| frpc 重启后 proxy already exists 一直在 retry | frps 旧 connection 还没超时清理 | 等 60 秒，或在 frps 端踢旧 client |

## 8. 升级流程

```bash
git pull
pnpm install
pnpm build:all
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere
```

config 不动，前端构建产出会被 fastify-static 即时服务。
