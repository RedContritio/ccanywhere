# Deployment — Staging 实例（同域不同 port）

跑一份独立的 ccanywhere instance 用于 e2e 测试或 dogfood-staging，与 prod
完全隔离。架构：

```
prod    https://cc.<your-domain>:443  ──frpc tunnel A──▶ 127.0.0.1:62275
staging https://cc.<your-domain>:7443 ──frpc tunnel B──▶ 127.0.0.1:62276
```

同 frpc 进程，同证书。**关键的隔离点**：

ccanywhere 主部署见 [deployment.md](./deployment.md)；frpc 配置见
[deployment-frpc.md](./deployment-frpc.md)。

## 1. staging config.json

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

## 2. staging launch agent

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

## 3. frpc 加 staging tunnel

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

## 4. 浏览器访问

`https://cc.<your-domain>:7443`，按提示 pair 一个 device label = `e2e-runner`。
pair 出来的 cookie name 是 `ccanywhere_session_e2e`，与 prod 的
`ccanywhere_session` 互不覆盖——浏览器同时看着两个 instance 也不会被踢
登录。

## 5. 验证隔离

```bash
# prod 与 staging 各自的 sessions 列表完全独立
curl -k -b "ccanywhere_session=<prod-cookie>"     https://cc.<your-domain>/api/sessions
curl -k -b "ccanywhere_session_e2e=<staging-cookie>" https://cc.<your-domain>:7443/api/sessions

# 两份 .devices.json 独立
ls /Users/<you>/Projects/.devices.json /Users/<you>/.ccanywhere-staging/projects/.devices.json
```
