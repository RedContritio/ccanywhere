# Deployment — frpc

frpc 作为 LaunchDaemon 自启 + frpc.toml 配置（plain TCP 与 https + 证书两种拓扑）。
ccanywhere 主部署见 [deployment.md](./deployment.md)；staging 实例见
[deployment-staging.md](./deployment-staging.md)。

## 1. frpc 作为 LaunchDaemon（可选）

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

## 2. frpc 配置

参考 `examples/frpc.toml`。两种拓扑选一种：

### A. plain TCP（最简，HTTP 暴露）

```toml
[[proxies]]
name = "ccanywhere"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8081
remotePort = 8081
```

公网入口：`http://<frps host>:8081/`。**没有 TLS**——只在你信任公网链路或
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

ccanywhere 用 acme.sh 通过 DNS-01 challenge 申 Let's Encrypt 证书。
acme.sh 支持 50+ DNS provider,常见的：

- Cloudflare（`dns_cf`）— 国际域名首选
- 阿里云（`dns_ali`）
- 腾讯云 DNSPod（`dns_tencent` 新 API / `dns_dp` 老 API）
- AWS Route53（`dns_aws`）
- 完整列表：[acme.sh DNS API](https://github.com/acmesh-official/acme.sh/wiki/dnsapi)
  (每个 plugin 各自的环境变量名也在那里)

仓库 `scripts/cert-issue.sh` 默认用腾讯云作 example。换 provider 时改
脚本里 `--dns dns_tencent` 为对应 plugin + 改 export 凭证变量即可。

**腾讯云示例:**

```bash
export Tencent_SecretId='<腾讯云 SecretId>'
export Tencent_SecretKey='<腾讯云 SecretKey>'
export CCANYWHERE_DOMAIN='cc.<your-domain>'
export CCANYWHERE_ACME_EMAIL='you@<your-domain>'
./scripts/cert-issue.sh
```

**Cloudflare 示例（改脚本一处 + 不同 env）:**

```bash
export CF_Key='<global-api-key>' CF_Email='<account-email>'   # 或用 CF_Token
export CCANYWHERE_DOMAIN='cc.<your-domain>'
export CCANYWHERE_ACME_EMAIL='you@<your-domain>'
# 把 cert-issue.sh 里 `--dns dns_tencent` 改成 `--dns dns_cf`
./scripts/cert-issue.sh
```

脚本做的事：

- 没装 acme.sh 的话用官方一行 installer 装到 `~/.acme.sh/`
- `--set-default-ca --server letsencrypt`（acme.sh 默认 ZeroSSL 需要 EAB，绕开）
- `--issue --dns <plugin> -d cc.<your-domain>`（DNS-01 challenge）
- `--install-cert` 安装到 `~/.config/ccanywhere/certs/`
- `--reloadcmd "sudo /bin/launchctl kickstart -k system/com.fatedier.frpc"`（写进 acme.sh
  config，续签时自动跑）
- `chmod 600` 收紧 `account.conf` 和 `.key` 文件

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
localAddr = "127.0.0.1:8081"
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
