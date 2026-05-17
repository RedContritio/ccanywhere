# Deployment — anthropic 代理 (m-anthropic-proxy, Phase 1)

独立 LaunchAgent 进程 `ccanywhere proxy serve`，listen
`config.proxy.port` (default 62276) on `config.proxy.bindHost`
(default 127.0.0.1)。**owner 路径不经此代理** (D7)，仅为 Phase 2
user 容器化做的基础设施。Phase 1 ship 后没真实流量经过；靠
`scripts/proxy-manual-verify.sh` + 单元测试验证。

主部署文档见 [deployment.md](./deployment.md)。

## 1. owner 真凭据

```bash
cat > ~/.config/ccanywhere/anthropic-credentials.json <<EOF
{ "apiKey": "sk-ant-..." }
EOF
chmod 600 ~/.config/ccanywhere/anthropic-credentials.json
```

- 文件不存在 → 代理以 **503 模式**启动 (admin 可以晚配，不
  crash-loop)，所有 forward 路由返 503
- mode 不是 0600 → 启动 fatal (拒绝读其他 user 可读的 key 文件)
- malformed JSON / 缺 `apiKey` 字段 → 启动 fatal

**任何 commit 进 git 前**检查这个文件没被加进，避免泄漏。

## 2. 代理 LaunchAgent

写 `~/Library/LaunchAgents/com.<you>.ccanywhere-proxy.plist`，跟主
ccanywhere LaunchAgent 平行：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.&lt;you&gt;.ccanywhere-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/ccanywhere/dist/cli.js</string>
    <string>proxy</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/ccanywhere</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/Users/&lt;you&gt;/.config/ccanywhere/proxy.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/&lt;you&gt;/.config/ccanywhere/proxy.log</string>
</dict>
</plist>
```

启动：

```bash
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.<you>.ccanywhere-proxy.plist
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere-proxy
curl -sf http://127.0.0.1:62276/healthz
# 应返 {"ok":true,"mode":"ready"} (有 credentials)
# 或   {"ok":true,"mode":"degraded"} (credentials 缺失，仍接 HEAD/healthz
# 但 forward 路由都返 503/404)
```

## 3. D7 边界提醒

owner 在主 ccanywhere session 内跑的 cc **不**经代理 — owner 直接
用 mac Keychain / `~/.claude/.credentials.json` 走 api.anthropic.com。
代理仅服务 Phase 2 user 容器内的 cc (Phase 2 ship 时 user 容器内
`ANTHROPIC_BASE_URL` 指向本代理)。

### 3.1 quota 共享警示

代理 "剩 80%" 是 ccanywhere 账本视角；Anthropic 真实 quota 跟
owner 自己用量**共享同一 subscription**。代理看不到 owner 直连消
耗，故代理余额 vs 真实余额可能错位。upstream 返 429 verbatim
forward，按 owner 自己上 Anthropic dashboard 排查使用比例。

代理**不**做自动告警 (避免依赖 Anthropic dashboard API)。

### 3.2 owner 真凭据 surface

owner 真凭据存在两处 surface (vs 改造前只在 1 处)：

1. macOS Keychain (原有，加密 + OS 级保护)
2. `~/.config/ccanywhere/anthropic-credentials.json` (mode 0600，
   **不加密**) + 代理进程内存

第 2 处是 Phase 1 新增攻击面。mitigation: 代理独立进程 (D1，blast
radius 限制) + 日志强制脱敏 (D4，启动 self-test failsafe) + 文件
mode 0600 启动校验 (D5)。

## 4. 手动 verify

```bash
./scripts/proxy-manual-verify.sh           # 跑完 kill proxy
./scripts/proxy-manual-verify.sh --keep    # 保留 proxy 后续 dogfood
```

脚本流程：

1. preflight: 检查 dist/cli.js + anthropic-credentials.json +
   users.json 三个文件齐全
2. 起 proxy in background + `curl /healthz` 验证存活
3. 读 `~/.config/ccanywhere/proxy-token-secret` (代理 issue 用)，
   颁发 owner id 的 5 分钟 bearer
4. `ANTHROPIC_BASE_URL=http://127.0.0.1:62276 ANTHROPIC_AUTH_TOKEN=<bearer>
   claude --print "OK"` 跑通
5. grep proxy log 验证 bearer 没漏 (D4 redact 兜底验证)

每次 schema bump / proxy 升级后跑一次。

## 5. 升级流程

```bash
git pull && pnpm install && pnpm build:all
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere-proxy
sleep 2 && curl -sf http://127.0.0.1:62276/healthz
```

proxy 改 schema (configDir 新字段) 时按主 server 同样规则：先
docs 同步 + user 显式同步 prod config + kickstart 验证。Phase 1
不动 schema，proxy 字段已带 zod default。

## 6. Phase 2 预告

`m-user-shared-container` (Phase 2) ship 时：
- user 容器内 cc 的环境变量自动注入
  `ANTHROPIC_BASE_URL=http://host.docker.internal:62276` +
  `ANTHROPIC_AUTH_TOKEN=<5min bearer>` (经 ccanywhere CLI 颁发)
- user 容器内 cc 走代理 → 代理转 owner key → upstream Anthropic
- 代理 inline quota check 在转发前查 `~/.config/ccanywhere/users.
  json` 的 `quota.cost.limitUsd` (Phase 1 已就位)
- 代理记账写 `proxy-usage.json` (Phase 1 已就位)
- Phase 2 follow-up: m-proxy-quota-sync 协调 proxy 账本与
  UserStore.quota.usedUsd
