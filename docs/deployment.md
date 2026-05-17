# Deployment

macOS 单机部署 ccanywhere + frpc。Linux 类似（用 systemd 替代 launchd）。

frpc 配置（LaunchDaemon + acme.sh + frpc.toml）见 [deployment-frpc.md](./deployment-frpc.md)。
Staging 实例（同域不同 port）见 [deployment-staging.md](./deployment-staging.md)。

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
| `webOrigin` | web SPA 实际服务的 origin（如 `https://ccanywhere.example.com`）。WebAuthn `rpID` 由其 hostname 派生；非 https 时 cookie `Secure` 关闭；改这一项会让所有已配对设备失效 |
| `projectsRoot` | 项目集合根目录（绝对路径），其直接子目录被自动列为可选项目；启动时不存在会自动 mkdir，不可读直接 fatal，不可写则只能列/选不能新建 |
| `guestProjectsRoot` | **必填**（m-multi-user）。limited user 项目沙盒父目录（绝对路径），其下每个 limited user 拿到一个 `<username>/` 子目录作 cwd 根。**MUST NOT** 与 `projectsRoot` 相同，**MUST NOT** 互为父子。启动时自动 `mkdir -p` (mode 0700)。详见 §7 |
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

## 4. 验证

```bash
# 本地
curl http://127.0.0.1:62275/healthz
# {"ok":true}

# 公网
curl http://<frps>:62275/healthz
# {"ok":true}

# 列项目（需要先 pair + login，浏览器里完成）
# 命令行调试 API 时用 mac CLI 的 internal 路由（cliToken 在 ~/.config/ccanywhere/cli-token）
CLI_TOKEN=$(cat ~/.config/ccanywhere/cli-token)
curl -H "Authorization: Bearer $CLI_TOKEN" http://127.0.0.1:62275/api/internal/devices
```

浏览器配对：`https://<webOrigin host>/login` → 输入设备名 → 申请配对 →
mac 终端跑 `ccanywhere approve` 选择该 pending → 浏览器自动跳到 workspace。
后续登入只需点「用本机生物识别登入」。

## 5. 排错

| 现象 | 可能原因 | 解决 |
|------|---------|------|
| 浏览器 401 / 反复跳回登录 | session cookie 过期或 device 被 revoke | 重新走「申请配对」+ `ccanywhere approve` |
| 申请配对没看到 pending | webOrigin 配错 / rpID 不匹配（浏览器侧 `navigator.credentials.create` 失败） | config 里 `webOrigin` 必须等于浏览器实际访问的 origin（含 scheme + host） |
| pending list 一直空 | 浏览器 register-init 收到了，但 register-complete 失败（可能因为 webOrigin 不匹配） | 看 server.log 是否有 `verification_failed` |
| 创建 session 即 dead | `claudeBin` 找不到（PATH 问题） | 改为绝对路径 |
| 创建 session 后跳到 cc 登录页 | 你跑的是 M5 旧版（CLAUDE_CONFIG_DIR 注入） | `git pull && pnpm build:all && launchctl kickstart -k …` |
| 卡顿明显 | 旧版 100ms trailing-flush | 同上，确认在 M-hook-opt-in 之后的版本 |
| 公网 / 返回 404 envelope | `web/dist/` 不存在 / 路径解析错 | `pnpm build:all` 后重启 |
| frpc 重启后 proxy already exists 一直在 retry | frps 旧 connection 还没超时清理 | 等 60 秒，或在 frps 端踢旧 client |
| 浏览器 `ERR_SSL_PROTOCOL_ERROR` / 连不上 443 | frps `vhostHTTPSPort` 没配，或公网 443 被防火墙挡 | `frps.toml` 加 `vhostHTTPSPort = 443` 重启 frps；云厂商安全组放行 443 |
| `acme.sh --issue` 卡在 "Verifying" | DNS 没生效或 TXT 记录写错 | `dig +short TXT _acme-challenge.cc.<domain>` 验证；DNS-01 凭证（Tencent_SecretId/Key）有没有 export |
| 续签 timer 跑了但 frpc 没拿到新证书 | sudoers NOPASSWD 没配，reloadcmd 静默失败 | `tail ~/.config/ccanywhere/cert-renew.log` 看错误；按 [deployment-frpc.md](./deployment-frpc.md) §2.B.4 配 sudoers |
| 浏览器证书 valid 但 `502 Bad Gateway` | frpc 拿到流量后回源 `127.0.0.1:62275` 不通 | `curl http://127.0.0.1:62275/healthz` 确认 ccanywhere 在跑 |

## 6. 升级流程

```bash
git pull
pnpm install
pnpm build:all
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere
```

### ⚠️ 从 quota 之前的版本升级（重要）

m-quota-cost-tracking ship 后 `UserPromptSubmit` hook 命令的 curl 必须
保留 stdout（旧版用 `>/dev/null 2>&1` 丢掉 stdout）。服务端在配额耗尽时
返回 cc 协议 JSON `{ decision: 'block', reason: ... }` 让 cc 停 prompt
——前提是 hook command 把这段 JSON 透传给 cc。

如果你以前手动贴过 `~/.claude/settings.json` hook 段，配额功能上线后
**必须** 把 `UserPromptSubmit` 事件下 curl 命令末尾的 `>/dev/null 2>&1`
改成 `2>/dev/null`（其它事件保持 `>/dev/null 2>&1`）。否则 limited user
超限时 cc 收不到 block 决策（hook 静默 fire-and-forget），prompt 照常
发送 → 上限失效。最新示例见 [`docs/hooks.md`](./hooks.md) §2。

owner 不受影响（owner 全程 quota skip）。

## 7. multi-user 配置（m-multi-user）

ccanywhere 支持单 owner + N 个 limited user。owner 走 WebAuthn 配对，
limited user 通过 token 登录（owner CLI 颁发）。每个 limited user 的项目
沙盒在 `<guestProjectsRoot>/<username>/` 下，不可访问 owner 的 `projectsRoot`。

### 7.1 config 必填字段

```json
{
  "projectsRoot": "/Users/<you>/Projects/cc",
  "guestProjectsRoot": "/Users/<you>/Projects/cc-guests",
  ...
}
```

`guestProjectsRoot` 与 `projectsRoot` MUST 不相同 + MUST 不互为父子。
启动时自动 `mkdir -p` (mode 0700)。

### 7.2 创建第一个 limited user

```bash
# 颁额度 + 颁初始 token
ccanywhere user create alice \
  --cost-usd 10 \
  --ttl 7d

# 输出形如：
# user.id: 8d5e...
# token.plaintext: <64-char hex>   ← 一次性显示，保存好
# 复制 token plaintext 发给 alice

# 查列表
ccanywhere user list

# 后续重新颁 token（旧 token 仍有效直到 ttl 结束或 revoke）
ccanywhere token issue alice --ttl 7d --label "iphone"

# 调整 limit / 重置 used
ccanywhere user quota set alice --cost-usd 20 --reset

# 撤 token
ccanywhere token list --user alice
ccanywhere token revoke <token-id>
```

### 7.3 limited user 浏览器登录

alice 拿到 token plaintext 后，浏览器访问 `https://<webOrigin host>/`
→ 切换到 "token 登录" → 粘贴 token → 服务端校验 + 颁 cookie。后续刷新自动用 cookie。

token 失效（revoke 或 expire）后 cookie 立即失效，回到登录页。

### 7.4 quota 行为

- limited user 超 `cost.limitUsd` 或 `tokens.limit` 任一时，下一次
  `UserPromptSubmit` 会被服务端拦截：cc 收到 `{ decision: 'block',
  reason: '...' }` JSON，停止 prompt 并在 terminal 显示 reason。
- 浏览器 terminal-header 的 💰 button 打开 quota panel，看 cost / tokens
  实时进度（30s 轮询）。
- quota 累加自 `user.createdAt`，token 轮换 / revoke / re-issue 不重置。
- 当轮 in-flight 不打断：拦截在下一次 prompt 提交时触发。

### 7.5 限制

- limited user 暂不能通过 web 创建项目（POST /api/projects 限 owner）。
  alice 的 cwd 必须由 owner 在 `<guestProjectsRoot>/alice/` 下预创建项目
  目录。
- limited user 无 WebAuthn 配对路径（仅 owner）；POST `/api/auth/webauthn/login-init`
  对 limited user 直接 403。
- token ttl ≤ 7d 硬限。要长期使用，owner 定期 re-issue。

详细 REST API 契约见 [`openspec/specs/rest-api/multi-user.spec.md`](../openspec/specs/rest-api/multi-user.spec.md)。
hook quota enforcement 见 [`openspec/specs/hooks/spec.md`](../openspec/specs/hooks/spec.md)
"UserPromptSubmit 是 quota 单一 enforcement 点"。

config 不动，前端构建产出会被 fastify-static 即时服务。

## 8. anthropic 代理（m-anthropic-proxy，Phase 1）

独立 LaunchAgent 进程 (`ccanywhere proxy serve`)，listen
`config.proxy.port` (default 62276) on `config.proxy.bindHost`
(default 127.0.0.1)。**owner 路径不经此代理** (D7)，仅为 Phase 2
user 容器化做的基础设施。Phase 1 ship 后没真实流量经过；靠
`scripts/proxy-manual-verify.sh` + 单元测试验证。

详细见 [deployment-proxy.md](./deployment-proxy.md)。

