# Deployment

单机部署 ccanywhere (macOS 使用 LaunchAgent,Linux 使用 systemd user unit)。
HTTPS frontend 默认 caddy(见 README §4);其它 reverse proxy + DNS-01
cert 流程见 `scripts/cert-issue.sh` 内嵌使用说明;tunnel(frp / Tailscale /
Cloudflare Tunnel)参考各自官方文档 reverse-proxy 到 `127.0.0.1:8081`。
Staging 实例(同域不同 port)见 [deployment-staging.md](./deployment-staging.md)。

## 前置

- macOS 或 Linux,Node 22+,pnpm
- cc CLI 已安装且 user 已经在本机用 `claude /login` 登录过
- **可选**:远程访问需要 reverse-proxy (caddy / frp / Tailscale / 等),
  本机自测可以跳过;主 README §6 列出各方案细节

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
| `port` | 默认 `8081`（一次性随机选定）。多机部署修改为其他端口 |
| `claudeBin` | 写**绝对路径**。LaunchAgent 的 PATH 不含 `~/.local/bin`，相对名 `claude` 会找不到导致 spawn 立即 dead |
| `webOrigin` | web SPA 实际服务的 origin。本机自测填 `http://localhost:<port>`（WebAuthn spec 对 localhost 例外）；远程访问填 `https://cc.example.com`。WebAuthn `rpID` 由其 hostname 派生；非 https 时 cookie `Secure` 关闭；**修改这一项会让所有已配对设备失效** |
| `workspace` | **required**。每个 user 项目沙盒父目录（绝对路径）。每个 user 自动得到 `<workspace>/<username>/` 作为 cwd 根。启动时自动 `mkdir -p` (mode 0700)。详见 §7 |
| `users.<name>.workspace` | 可选 per-user 覆盖。owner 默认 username 是 `owner`，使用默认 `<workspace>/owner/`；想指向已有 repo 目录（如 `/Users/<you>/Projects`）就配置 `users.owner.workspace`。两个 user override MUST NOT 互嵌或与他人默认槽位冲突，schema 启动校验 |
| `outputFps` | WS 输出最大帧率，1..240 默认 60。带宽紧张可调到 24 |
| `deletedSessionTtlMs` | 软删除保留时长，默认 600_000（10 分钟）|
| `wsHeartbeat.timeoutMs` | 必须严格大于 `intervalMs`，默认 60000/30000 |

### 关于 `claudeBin` 的坑

```bash
which claude
# /Users/<you>/.local/bin/claude
```

LaunchAgent / LaunchDaemon 的 PATH 默认是 `/usr/bin:/bin:/usr/sbin:/sbin`，
**不含** `~/.local/bin`。把 `claudeBin` 写绝对路径最稳。

## 3. ccanywhere 作为常驻服务

按平台选一份 service install 文档跟着做:

- **macOS LaunchAgent**: [deployment-macos.md](./deployment-macos.md)
- **Linux systemd**: [deployment-linux.md](./deployment-linux.md)

后续 §5 排错 / §6 升级里出现 `<reload-service>` 占位符,按平台展开:

| 平台 | reload 命令 |
|------|------------|
| macOS | `launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere` |
| Linux | `systemctl --user restart ccanywhere.service` |

## 4. 验证

```bash
# 本地
curl http://127.0.0.1:8081/healthz
# {"ok":true}

# 公网
curl http://<frps>:8081/healthz
# {"ok":true}

# 列项目（需要先 pair + login，浏览器里完成）
# 命令行调试 API 时用 mac CLI 的 internal 路由（cliToken 在 ~/.config/ccanywhere/cli-token）
CLI_TOKEN=$(cat ~/.config/ccanywhere/cli-token)
curl -H "Authorization: Bearer $CLI_TOKEN" http://127.0.0.1:8081/api/internal/devices
```

浏览器配对：`https://<webOrigin host>/login` → 输入设备名 → 申请配对 →
mac 终端运行 `ccanywhere approve` 选择该 pending → 浏览器自动跳到 workspace。
后续登入只需点击「用本机生物识别登入」。

## 5. 排错

| 现象 | 可能原因 | 解决 |
|------|---------|------|
| 浏览器 401 / 反复跳回登录 | session cookie 过期或 device 被 revoke | 重新执行「申请配对」+ `ccanywhere approve` |
| 申请配对没看到 pending | webOrigin 配置错误 / rpID 不匹配（浏览器侧 `navigator.credentials.create` 失败） | config 里 `webOrigin` 必须等于浏览器实际访问的 origin（含 scheme + host） |
| pending list 一直空 | 浏览器 register-init 收到了，但 register-complete 失败（可能因为 webOrigin 不匹配） | 查看 server.log 是否有 `verification_failed` |
| 创建 session 即 dead | `claudeBin` 找不到（PATH 问题） | 修改为绝对路径 |
| 创建 session 后跳到 cc 登录页 | 当前运行的是 M5 旧版（CLAUDE_CONFIG_DIR 注入） | `git pull && pnpm build:all && <reload-service>` |
| 卡顿明显 | 旧版 100ms trailing-flush | 同上，确认在 M-hook-opt-in 之后的版本 |
| 公网 / 返回 404 envelope | `web/dist/` 不存在 / 路径解析错 | `pnpm build:all` 后重启 |
| 浏览器 `ERR_SSL_PROTOCOL_ERROR` / 连不上 443 | reverse proxy 未监听 443,或公网 443 被防火墙拦截 | 检查 reverse proxy 实际监听端口;云厂商安全组放行 443 |
| 浏览器证书 valid 但 `502 Bad Gateway` | reverse proxy 拿到流量后回源 `127.0.0.1:8081` 不通 | `curl http://127.0.0.1:8081/healthz` 确认 ccanywhere 在运行 |

平台特定排错 (LaunchAgent / systemd 服务状态、证书续签 timer、frpc 重启
等) 见 [deployment-macos.md](./deployment-macos.md) /
[deployment-linux.md](./deployment-linux.md)。

## 6. 升级流程

```bash
git pull
pnpm install
pnpm build:all
<reload-service>           # 见 §3 reload 命令表
```

### ⚠️ 从 quota 之前的版本升级（重要）

quota 功能发布后 `UserPromptSubmit` hook 命令的 curl 必须
保留 stdout（旧版用 `>/dev/null 2>&1` 丢掉 stdout）。服务端在配额耗尽时
返回 cc 协议 JSON `{ decision: 'block', reason: ... }` 让 cc 停止 prompt
——前提是 hook command 把这段 JSON 透传给 cc。

如果你以前手动贴过 `~/.claude/settings.json` hook 段，配额功能上线后
**必须** 把 `UserPromptSubmit` 事件下 curl 命令末尾的 `>/dev/null 2>&1`
改成 `2>/dev/null`（其它事件保持 `>/dev/null 2>&1`）。否则 limited user
超限时 cc 收不到 block 决策（hook 静默 fire-and-forget），prompt 照常
发送 → 上限失效。最新示例见 [`docs/hooks.md`](./hooks.md) §2。

owner 不受影响（owner 全程 quota skip）。

## 7. multi-user 配置

ccanywhere 支持单 owner + N 个 limited user。owner 通过 WebAuthn 配对，
limited user 通过 token 登录（owner CLI 颁发）。每个 user（含 owner）
默认 cwd 根是 `<workspace>/<username>/`；想指向已有目录就 per-user
`workspace` override。

### 7.1 config 字段

```json
{
  "workspace": "/Users/<you>/ccanywhere-workspace",
  "users": {
    "owner": { "workspace": "/Users/<you>/Projects" },
    "alice": { "runtime": "host" }
  },
  ...
}
```

- `workspace`（required）：所有 user 项目沙盒父目录。启动时自动
  `mkdir -p` (mode 0700)
- `users.owner.workspace`（可选）：owner 指向已有 repo 目录，不指
  则使用 `<workspace>/owner/` + 启动 warning
- `users.<other>.workspace`（可选）：non-owner 指向他用的目录；不
  指就 `<workspace>/<username>/`。任何两个 override MUST 不相同 +
  MUST 不互为父子，schema 启动校验

### 7.2 创建第一个 limited user

```bash
# 颁发额度 + 颁发初始 token
ccanywhere user create alice \
  --cost-usd 10 \
  --ttl 7d

# 输出形如：
# user.id: 8d5e...
# token.plaintext: <64-char hex>   ← 一次性显示，保存好
# 复制 token plaintext 发给 alice

# 查看列表
ccanywhere user list

# 后续重新颁发 token（旧 token 仍有效直到 ttl 结束或 revoke）
ccanywhere token issue alice --ttl 7d --label "iphone"

# 调整 limit / 重置 used
ccanywhere user quota set alice --cost-usd 20 --reset

# 撤销 token
ccanywhere token list --user alice
ccanywhere token revoke <token-id>
```

### 7.3 limited user 浏览器登录

alice 拿到 token plaintext 后，浏览器访问 `https://<webOrigin host>/`
→ 切换到 "token 登录" → 粘贴 token → 服务端校验 + 颁发 cookie。后续刷新自动用 cookie。

token 失效（revoke 或 expire）后 cookie 立即失效，回到登录页。

### 7.4 quota 行为

- limited user 超 `cost.limitUsd` 或 `tokens.limit` 任一时，下一次
  `UserPromptSubmit` 会被服务端拦截：cc 收到 `{ decision: 'block',
  reason: '...' }` JSON，停止 prompt 并在 terminal 显示 reason。
- 浏览器 terminal-header 的 💰 button 打开 quota panel，查看 cost / tokens
  实时进度（30s 轮询）。
- quota 累加自 `user.createdAt`，token 轮换 / revoke / re-issue 不重置。
- 当轮 in-flight 不打断：拦截在下一次 prompt 提交时触发。

### 7.5 限制

- limited user 暂不能通过 web 创建项目（POST /api/projects 限 owner）。
  alice 的 cwd 必须由 owner 在 `<workspace>/alice/`（或 `users.alice.
  workspace` 指向的目录）下预创建项目子目录。
- limited user 无 WebAuthn 配对路径（仅 owner）；POST `/api/auth/webauthn/login-init`
  对 limited user 直接 403。
- token ttl ≤ 7d 硬限。要长期使用，owner 定期 re-issue。

REST API 路由在 `src/server/routes/`;hook quota enforcement 单一节点
在 `UserPromptSubmit` (见 `docs/hooks.md`)。

config 不动，前端构建产出会被 fastify-static 即时服务。

## 8. anthropic 代理

由 ccanywhere main 启动时自动 spawn 的子进程 (`ccanywhere proxy serve`)，
listen `config.proxy.port` (default 8082)。proxy 当前**不在 user 流量
路径上** — Anthropic 2026-02 起禁止第三方应用通过 `Authorization: Bearer`
转发 OAuth subscription token, user 容器内 cc 改用 `CLAUDE_CODE_OAUTH_
TOKEN` env 直连 anthropic。proxy 仍 listen 作为 future fallback
(owner 切换到 Console API key 时 re-enable)。详见
[deployment-proxy.md](./deployment-proxy.md) §3。

## 9. user runtime 隔离策略

admin 在 `config.isolationPolicy` 声明全局策略，`config.users.<name>.runtime`
声明 per-user 沙箱。启动时校验配置 + 输出当前 isolation 模式 + 在
`/healthz` 暴露状态。

详细见 [deployment-isolation.md](./deployment-isolation.md)。

## 10. user 容器化

shared container spawn: admin 配置 `runtime: 'shared-container'` 时 user
session 通过 `docker exec` 进入 ccanywhere-shared-<port> 容器内运行
claude。anthropic 流量**不经 proxy**, 直接使用 owner OAuth subscription
(容器内 setup-token + env inject)。容器内 per-user `~/.claude` 挂载
到 host (`~/.config/ccanywhere/user-claude/<user>/`,
含 jsonl history + settings + baked CLAUDE.md / permission-deny)。
owner 路径零改动。详见 [deployment-container.md](./deployment-container.md)。

