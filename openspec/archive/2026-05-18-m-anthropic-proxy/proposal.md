---
status: archived
---

# Proposal: m-anthropic-proxy — 自建 Anthropic API 代理

## Intent

ccanywhere 当前架构下所有 user session spawn 的 claude 直接调
`api.anthropic.com`，用 owner 的订阅凭据（mac Keychain）。这带来三
个无法切分的问题：

1. **owner credentials 全裸**。user 在 session 内 `cat
   ~/.claude/.credentials.json` 或读 Keychain（mac 上更难但非不可
   能）一行命令拿到 owner 凭据。
2. **配额计量靠 jsonl 文件 watch**（QuotaWatcher）。post-hoc 检测，
   非 inline enforce，user 可能在 watcher 反应前把 quota 用爆。
3. **未来容器化的前置基础设施**。Phase 2 m-user-shared-container
   要让容器内的 claude 走可控 endpoint —— 没有代理 = 没法切。

**本 Change 不做容器化**。仅落代理 server，owner 路径零变化（host
直连，D7），user 路径仍直连（等 Phase 2 m-user-shared-container
才切到代理）。**代理上线初期没有真实流量**——deliberate trade-off：
Phase 1 仅准备基础设施，Phase 2 才接入真用户。验证靠 e2e 自动测
+ 手动 verify 脚本。

P2 验证（spike-p2-verify.md）已确认 claude 2.1.133 完全支持
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 走自定义代理。

## Scope

新增独立进程 `ccanywhere-anthropic-proxy`（独立 binary，独立
LaunchAgent，独立日志），fastify based，listen 127.0.0.1:62276。

代理只实现 claude 真正调用的 endpoints（见 spike F1）：

- `POST /v1/messages` （含 SSE streaming，prefix match `?beta=...`）
- `POST /v1/messages/count_tokens`
- `HEAD /` （启动 probe，返 200）
- `GET /v1/models` （可选，仅当下游需要时；v1 暂不实现，404）

代理职责：

1. 接收 `Authorization: Bearer <ccanywhere-issued-token>`
2. 服务端验 token → 解析出 userId
3. 替换 `Authorization` 为 owner 真凭据（启动时从
   `~/.config/ccanywhere/anthropic-credentials.json` mode 0600 读
   入内存）
4. 转发到 `api.anthropic.com`，流式响应 pipe back
5. 解析 response 里 usage 字段 → 按 userId 计入用量记账
6. inline quota check：转发前查 userId 当前 quota，超额 429
7. 日志强制脱敏（任何 `authorization` / `x-api-key` header 与
   request body 内的 token 字段写日志前 redact）

owner 与 user 都通过代理调用——v1 只迁 owner（dogfood），user 等
Phase 2。

## 决策

### D1. 独立进程（不在 ccanywhere server 进程内）

理由：owner 真凭据是新引入的最敏感 secret。如果跟主 server 同进
程，server 任何 RCE / 内存泄漏 = owner key 泄漏。独立进程 = blast
radius 限制在代理。

### D2. token 格式：bearer 短时效，apiKeyHelper rotation

代理颁发的 token 走 `ANTHROPIC_AUTH_TOKEN` env 注入 claude。TTL 5
分钟，过期由 claude 通过 `apiKeyHelper` 拉新 token（官方机制）。
即便 token 短暂 leak 到 `/proc/<pid>/environ`，5 分钟后失效。

token format：`cca_<user-id>_<base64-nonce>`（自包含 userId 用于
代理验签 + 防重放 nonce）。

### D3. 计量按 response usage 字段（不按 request 次数）

理由：SDK 自带 retry（spike F3），按 request 算会 double-count。
按 response `usage.input_tokens + usage.output_tokens` 算才准。

失败响应（5xx / 4xx）不计费。

### D4. 日志脱敏强制 + 启动时校验

代理 logger 初始化时安装 redact rule：
- `req.headers.authorization` → `[REDACTED]`
- `req.headers['x-api-key']` → `[REDACTED]`
- request body 内 `api_key` / `auth_token` 字段 → `[REDACTED]`

启动时跑 self-test：写一条带 auth header 的假 log，grep 出来必须
看不到原 token 才能继续启动。否则 fatal。

### D5. owner 凭据来源：单独 credentials 文件，不进 schema

owner 真凭据存 `~/.config/ccanywhere/anthropic-credentials.json`
（mode 0600，启动时 chmod 校验），格式：

```json
{ "apiKey": "sk-ant-..." }
```

不进 `config.json`：理由是 config.json 经常需要 user 编辑（加
user / 改 workspace / 改 port），凭据放进去增加误 chmod / 误
commit 风险。独立文件 + 严格 perm = 单一职责。

启动时如果文件不存在：代理仍启动但拒绝所有转发请求（503），日志
写明缺失。owner 可以晚一步配。

### D6. v1 不实现 `/v1/models`，留 reserved

ccanywhere 当前 claude 调用不需要 model discovery。如果未来开
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 才需要。本 Change
返 404，留 m-anthropic-proxy-models follow-up。

### D7. owner 路径零改动 + quota 共享显式承认

owner 在 host 直接 spawn claude（沿用现有路径），不经代理，不计
量，不查 quota。理由：
- owner 是唯一管理员，已持有真凭据，走代理是绕远
- proxy 挂了 owner 仍能修
- 性能 / 调试 / 容错全有收益

代价（必须 spec 显式记录）：
- ccanywhere 层"owner 无限配额"是账本约定
- Anthropic 层 owner + user **共享同一 subscription quota**
- 代理看到的 user 余额不计 owner 用量；代理"剩 80%"可能上游实际
  剩 20%

mitigation：proxy 在 upstream 返回 429 时 verbatim forward，触发
后 owner 自己去 Anthropic dashboard 排查使用比例。不做自动告警
（避免代理依赖 Anthropic dashboard API）。

## 落地点

| 文件 | 改动 |
|---|---|
| `src/proxy/server.ts` (新建) | fastify 代理 server 主入口 |
| `src/proxy/forward.ts` (新建) | `/v1/messages` 转发 + SSE pipe |
| `src/proxy/tokens.ts` (新建) | 颁发/校验 bearer token |
| `src/proxy/credentials.ts` (新建) | owner 真凭据加载 + chmod 校验 |
| `src/proxy/metering.ts` (新建) | usage 字段解析 + 按 userId 记账 |
| `src/proxy/quota-check.ts` (新建) | inline quota 检查 |
| `src/proxy/log-redact.ts` (新建) | logger redact rules + self-test |
| `src/cli/proxy-serve.ts` (新建) | proxy CLI 入口 |
| `src/cli.ts` | 注册 `proxy serve` 子命令 |
| `src/config/schema.ts` | + `proxy.port` (default 62276) `proxy.bindHost` (default 127.0.0.1) |
| `scripts/install-launchagent-proxy.sh` (新建) | 安装 proxy LaunchAgent |
| `docs/deployment.md` | + proxy 部署段 + owner 凭据文件 + ANTHROPIC_BASE_URL 配置 |

预计 ~800 LOC src + ~300 LOC test，比初版 1100 LOC 估算低，因为
只实现 claude 真用的 endpoints（spike 收敛了范围）。

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| owner 真凭据不出代理进程内存 | D1 独立进程 + D4 日志脱敏 + D5 文件 mode 0600 启动校验 |
| token leak ≤ 5 分钟窗口 | D2 短 TTL + apiKeyHelper rotation |
| 计量不被 SDK retry double-count | D3 按 response usage 算 |
| 日志不漏 secret | D4 启动 self-test 失败则 fatal |
| 代理崩溃不影响主 server | D1 独立进程，独立 LaunchAgent |
| quota 是 inline enforce 不是 post-hoc | proxy 转发前检查，超额直接 429 |
| ccanywhere 主 server 0 改动 | 本 Change 不动 src/server/* |
| owner spawn 路径零改动 | D7，本 Change 不动 user/owner spawn 代码 |
| owner 真凭据 surface 显式记账 | Keychain (原有) + proxy 文件 0600 (D5) + proxy 内存 (D1) — 共 2 处新增（文件 + 内存），非 1 处 |

## 不做

- 不容器化（Phase 2 m-user-shared-container）
- 不改 owner spawn 路径（D7，host 直连，零改动）
- 不改 user spawn 路径（user 仍直连 api.anthropic.com 走 owner
  Keychain；Phase 2 才切到代理）
- 不 dogfood owner 路径走代理（D7：owner 路径零改动；想临时手动
  验证可 export `ANTHROPIC_BASE_URL`，但不纳入主流程）
- 不实现 `/v1/models`（D6 reserved）
- 不实现 cloud provider 路由（Bedrock/Vertex/Foundry）
- 不实现 OpenAI compat 模式
- 不实现 owner / user 用量自动告警（D7 mitigation：靠 Anthropic
  dashboard，代理仅 forward 429）
- 不替代当前 QuotaWatcher（共存：代理 inline 是 user enforce 层，
  QuotaWatcher 仍读 jsonl 算总账核对）

## 后续 follow-up

- **m-user-runtime-schema** (Phase 1.B，可并行)：schema 加
  `isolationPolicy` + per-user `runtime` 字段 + banner
- **m-user-shared-container** (Phase 2)：user 容器化，注入
  `ANTHROPIC_BASE_URL` 指向本代理
- **m-anthropic-proxy-models** (reserved)：实现 `/v1/models` 当
  需要 gateway model discovery 时
- **m-anthropic-proxy-multi-key** (reserved)：支持 owner 配多个
  upstream key（如分 prod/test）

## 前置 prototype

- ✅ P2 (spike-p2-verify.md) — `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` 通路验证完成
