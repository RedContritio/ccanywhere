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
| `webOrigin` | web SPA 实际服务的 origin（如 `https://ccanywhere.example.com`）。WebAuthn `rpID` 由其 hostname 派生；非 https 时 cookie `Secure` 关闭；改这一项会让所有已配对设备失效 |
| `projectsRoot` | 项目集合根目录（绝对路径），其直接子目录被自动列为可选项目；启动时不存在会自动 mkdir，不可读直接 fatal，不可写则只能列/选不能新建 |
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

frpc 的 `https2http` plugin 在本机终结 TLS。整套流程分五步，**严格按序**：

#### B.1 DNS 加 A 记录

域名注册商控制台加 `cc.<your-domain> A <frps 公网 IP>`。`dig +short cc.<your-domain>`
能返回 frps IP 才进下一步——DNS 没生效跑 acme 一定失败。

#### B.2 frps 端开 vhost

`frps.toml` 加：

```toml
vhostHTTPSPort = 443
```

重启 frps，**确认公网防火墙 / 云厂商安全组放行 443**。`transport.tls.force = true`
是控制通道（frpc ↔ frps）的 TLS，与 vhost https 完全独立，无冲突。

#### B.3 申请证书（一次性）

仓库里 `scripts/cert-issue.sh` 封装了 acme.sh 安装 + Let's Encrypt 申请 + 安装到固定路径：

```bash
export Tencent_SecretId='<腾讯云 SecretId>'
export Tencent_SecretKey='<腾讯云 SecretKey>'
CCANYWHERE_DOMAIN=cc.<your-domain> ./scripts/cert-issue.sh
```

脚本做的事：

- 没装 acme.sh 的话用官方一行 installer 装到 `~/.acme.sh/`
- `--set-default-ca --server letsencrypt`（acme.sh 默认 ZeroSSL 需要 EAB，绕开）
- `--issue --dns dns_tencent -d cc.<your-domain>`（DNS-01 challenge）
- `--install-cert` 安装到 `~/.config/ccanywhere/certs/`
- `--reloadcmd "sudo /bin/launchctl kickstart -k system/com.fatedier.frpc"`（写进 acme.sh
  config，续签时自动跑）
- `chmod 600` 收紧 `account.conf` 和 `.key` 文件

DNS 提供商不是腾讯云的话，参考 [acme.sh DNS API 列表](https://github.com/acmesh-official/acme.sh/wiki/dnsapi)
找对应的 plugin（`dns_cf` Cloudflare、`dns_aliyun` 阿里云、`dns_dp` DNSPod 老 API、…），
脚本里把 `dns_tencent` 替换即可。

#### B.4 sudoers NOPASSWD（让续签后能 reload frpc）

frpc 是 LaunchDaemon（system 级），重启需要 sudo。续签 launchd timer 是 LaunchAgent
（用户级）跑，没法弹密码框。一次性给特定命令免密：

```bash
sudo visudo -f /etc/sudoers.d/ccanywhere-cert
```

写一行（替换 `<you>` 为你的 mac 用户名）：

```
<you> ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/com.fatedier.frpc
```

保存后 macOS 自动 `chmod 0440`。**作用域只有这一个 launchctl 命令**，没有放大权限。

立刻验证免密：

```bash
sudo -n /bin/launchctl kickstart -k system/com.fatedier.frpc
# 不应该提示输密码
```

#### B.5 改 frpc.toml + 重启 frpc

`~/.config/frp/frpc.toml` 里把 ccanywhere 那段从 `type = "tcp"` 换成：

```toml
[[proxies]]
name = "ccanywhere"
type = "https"
customDomains = ["cc.<your-domain>"]

[proxies.plugin]
type = "https2http"
localAddr = "127.0.0.1:62275"
crtPath = "/Users/<you>/.config/ccanywhere/certs/cc.<your-domain>.crt"
keyPath = "/Users/<you>/.config/ccanywhere/certs/cc.<your-domain>.key"
hostHeaderRewrite = "cc.<your-domain>"
```

`crtPath` / `keyPath` 用**绝对路径**（frp 不展开 `~`）。同 frpc.toml 里的其他 tcp proxy
（ssh、其它服务）不受影响。

```bash
sudo launchctl kickstart -k system/com.fatedier.frpc
tail -20 ~/.config/frp/frpc.log    # 看启动是否成功
```

公网入口：`https://cc.<your-domain>/`。

#### B.6 装自动续签 LaunchAgent（每天 04:00 检查）

模板在 `examples/launchd/com.example.cc-cert-renew.plist`。把 `<you>` 替换成你的用户名，
拷到 `~/Library/LaunchAgents/`：

```bash
DST=~/Library/LaunchAgents/com.$(whoami).cc-cert-renew.plist
cp examples/launchd/com.example.cc-cert-renew.plist "$DST"
sed -i '' "s/__YOU__/$(whoami)/g" "$DST"
launchctl bootstrap gui/$(id -u) "$DST"
```

模板里用 `__YOU__` 占位是因为 `<you>` 在 XML 里非法（被当成标签开头），会让 plist 解析失败。

立即试跑一次确认能跑通：

```bash
launchctl kickstart gui/$(id -u)/com.<you>.cc-cert-renew
sleep 3
tail -20 ~/.config/ccanywhere/cert-renew.log
```

第一次跑通常会输出 "Skip, Next renewal time is …"——证书还远没到期不需要续。
正常。`acme.sh --cron` 检查到期前 30 天才会真触发续签 + reload。

## 6. 验证

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

## 7. 排错

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
| 续签 timer 跑了但 frpc 没拿到新证书 | sudoers NOPASSWD 没配，reloadcmd 静默失败 | `tail ~/.config/ccanywhere/cert-renew.log` 看错误；按 5.B.4 配 sudoers |
| 浏览器证书 valid 但 `502 Bad Gateway` | frpc 拿到流量后回源 `127.0.0.1:62275` 不通 | `curl http://127.0.0.1:62275/healthz` 确认 ccanywhere 在跑 |

## 8. 升级流程

```bash
git pull
pnpm install
pnpm build:all
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere
```

config 不动，前端构建产出会被 fastify-static 即时服务。

## 9. Staging 实例（同域不同 port）

跑一份独立的 ccanywhere instance 用于 e2e 测试或 dogfood-staging，与 prod
完全隔离。架构：

```
prod    https://cc.<your-domain>:443  ──frpc tunnel A──▶ 127.0.0.1:62275
staging https://cc.<your-domain>:7443 ──frpc tunnel B──▶ 127.0.0.1:62276
```

同 frpc 进程，同证书。**关键的隔离点**：

### 9.1 staging config.json

`~/.config/ccanywhere-staging/config.json`：

```json
{
  "port": 62276,
  "bindHost": "127.0.0.1",
  "claudeBin": "/Users/<you>/.local/bin/claude",
  "projectsRoot": "/Users/<you>/.ccanywhere-staging/projects",
  "webOrigin": "https://cc.<your-domain>:7443",
  "cookieName": "ccanywhere_session_e2e"
}
```

四个差异点（其它字段保持 prod 默认）：

| 字段 | staging 值 | 为什么 |
|---|---|---|
| `port` | 与 prod 不同（如 `62276`） | 同主机两 instance 不能抢端口 |
| `projectsRoot` | 完全独立路径 | `.devices.json` / `.projects-state.json` / cc 子进程的 cwd 全自动隔离，cc history (`~/.claude/projects/<encoded-cwd>/...`) 因 cwd 不同自动落到不同目录 |
| `webOrigin` | 含 `:7443` 端口 | WebAuthn `rpID` 由 hostname 派生（同 prod = `cc.<your-domain>`），但 origin 校验严格匹配 scheme+host+port |
| `cookieName` | 与 prod 不同（如 `ccanywhere_session_e2e`） | RFC 6265 cookie 忽略 port —— 同 host 同 cookie name 浏览器 last-write-wins，staging Set-Cookie 会踢掉 prod 会话；用不同 name 让两份 cookie 共存 |

实例状态文件（cli-token / devices.json / projects-state.json / feedback/）
默认落到 config 文件所在目录——把 staging config.json 放到
`~/.config/ccanywhere-staging/`，所有 staging 状态文件就自动落到那里，
与 prod 完全隔离。

### 9.2 staging launch agent

`~/Library/LaunchAgents/com.<you>.ccanywhere-staging.plist`：复制 prod
plist，改三处：

```xml
<key>Label</key>
<string>com.<you>.ccanywhere-staging</string>

<key>ProgramArguments</key>
<array>
  <string>/Users/<you>/.nvm/versions/node/<version>/bin/node</string>
  <string>/path/to/ccanywhere/dist/cli.js</string>
  <string>--config</string>
  <string>/Users/<you>/.config/ccanywhere-staging/config.json</string>
</array>

<key>StandardOutPath</key>
<string>/Users/<you>/.config/ccanywhere-staging/server.log</string>
<key>StandardErrorPath</key>
<string>/Users/<you>/.config/ccanywhere-staging/server.log</string>
```

加载、重启、卸载方式与 prod 一致，把 Label 替换即可。**关键点是
ProgramArguments 里加 `--config` 指向 staging config.json**——不需要 env
var，每份 config 文件 self-contained 描述一个完整实例。

mac CLI 操作 staging（罕见，e2e 通常用 fetch+cliToken 不走 mac CLI）：

```bash
ccanywhere --config ~/.config/ccanywhere-staging/config.json approve
ccanywhere --config ~/.config/ccanywhere-staging/config.json devices
```

### 9.3 frpc 加 staging tunnel

在 `frpc.toml` 末尾追加：

```toml
[[proxies]]
name = "ccanywhere-staging"
type = "https"
customDomains = ["cc.<your-domain>"]
# 不同的远端端口让 vhost 路由到不同 tunnel
remotePort = 7443

[proxies.plugin]
type = "https2http"
localAddr = "127.0.0.1:62276"
crtPath = "/Users/<you>/.config/ccanywhere/certs/cc.<your-domain>.crt"
keyPath = "/Users/<you>/.config/ccanywhere/certs/cc.<your-domain>.key"
hostHeaderRewrite = "cc.<your-domain>"
```

frps 端确保 `vhostHTTPSPort` 没限制并放行 7443，或单独配 `vhostHTTPSPort2`
之类（看 frps 版本支持）。

`sudo launchctl kickstart -k system/com.fatedier.frpc` 重 frpc 应用配置。

### 9.4 浏览器访问

`https://cc.<your-domain>:7443`，按提示 pair 一个 device label = `e2e-runner`。
pair 出来的 cookie name 是 `ccanywhere_session_e2e`，与 prod 的
`ccanywhere_session` 互不覆盖——浏览器同时看着两个 instance 也不会被踢
登录。

### 9.5 验证隔离

```bash
# prod 与 staging 各自的 sessions 列表完全独立
curl -k -b "ccanywhere_session=<prod-cookie>"     https://cc.<your-domain>/api/sessions
curl -k -b "ccanywhere_session_e2e=<staging-cookie>" https://cc.<your-domain>:7443/api/sessions

# 两份 .devices.json 独立
ls /Users/<you>/Projects/.devices.json /Users/<you>/.ccanywhere-staging/projects/.devices.json
```
