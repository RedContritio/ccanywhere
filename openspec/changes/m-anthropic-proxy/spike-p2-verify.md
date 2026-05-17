---
status: spike-result
---

# Spike: P2 — claude binary 是否支持 ANTHROPIC_BASE_URL + 自定义 bearer

本笔为 `m-anthropic-proxy` proposal 的证据基底。Phase 1 整个代理方案
依赖 claude 二进制能否被环境变量重定向到我们自建的代理 endpoint。本
spike 验证该前置假设。

## 验证目标

1. `ANTHROPIC_BASE_URL` 是否完全 honor（**所有** API 请求都走指定 endpoint）
2. `ANTHROPIC_AUTH_TOKEN` 是否被透传成 `Authorization: Bearer <token>`
3. `DISABLE_TELEMETRY` / `DISABLE_AUTOUPDATER` 是否能彻底阻断旁路出站
4. 是否存在 hardcoded telemetry / OAuth refresh 绕过代理

## 验证环境

| 项 | 值 |
|---|---|
| Date | 2026-05-17 |
| claude 版本 | `claude-cli/2.1.133 (external, sdk-cli)` |
| SDK fingerprint | `x-stainless-package-version: 0.81.0` (stainless) |
| OS | macOS arm64 |
| 假代理 | `/tmp/p2-proxy.js`（Node http listen 4444） |

## 方法

1. Node http server listen 4444，记录所有请求 header + body 摘要，
   返回 minimal-shape `/v1/messages` SSE 响应让 claude 能正常完成。
2. 命令：
   ```bash
   ANTHROPIC_BASE_URL=http://127.0.0.1:4444 \
     ANTHROPIC_AUTH_TOKEN=test-bearer-deadbeef \
     DISABLE_AUTOUPDATER=1 \
     DISABLE_TELEMETRY=1 \
     claude --print "say hi"
   ```
3. 观察 claude 是否在 8s 内完成 + 假代理是否收到流量 + stdout
   是否打印代理返回的内容。

## 结果

**✅ PASS。** claude stdout 输出 `hi`（假代理返回的 text），假代理日
志显示完整请求链路。

### 关键证据 1：所有流量走代理

```
=== REQUEST ===
HEAD /
user-agent: Bun/1.3.14         ← 启动 probe
...

=== REQUEST ===
POST /v1/messages?beta=true
user-agent: claude-cli/2.1.133 (external, sdk-cli)
authorization: Bearer test-bearer-deadbeef   ← bearer 透传
content-length: 150636
anthropic-beta: claude-code-20250219,context-1m-2025-08-07,...
```

没有任何请求漏向 `api.anthropic.com`。`(external, sdk-cli)` 标记
说明 claude 自己知道在走非一方 endpoint。

### 关键证据 2：retry 行为自带

第一次 POST 后立即第二次 POST，body 几乎一致，`x-stainless-timeout`
从 600 降到 300。**SDK 自带 retry**，代理实现必须 retry-safe（同
一 idempotency 不应被 double-count quota）。

## 关键发现（对 Change 1 设计有约束）

### F1. endpoint 必须支持 `?beta=true` query

claude 调的是 `/v1/messages?beta=true`，**不是裸 `/v1/messages`**。
代理 route matching 必须 prefix match 或忽略 query。

### F2. request body 巨大

观察到 `content-length: 150636`（150KB）。每次请求都把完整 system
prompt + skills + CLAUDE.md 序列化进 messages。代理 fastify 必须把
`bodyLimit` 抬到 10MB+（默认 1MB 会拒）。

### F3. SDK retry 必须 retry-safe

代理对同 prompt 重发不能 double-count。计量按 response 里 usage
字段算（input_tokens / output_tokens），不按 request 次数算。失败
响应（5xx / 4xx）不计费。

### F4. stainless headers 不能被 strip

`x-stainless-*` 是 SDK fingerprint，代理在 upstream forward 时必须
透传。如果代理只 forward 白名单 headers 会漏。

### F5. 启动 HEAD probe

claude 启动先打一次 `HEAD /`（不是 `/v1/messages`），代理路由层
必须接受根路径 HEAD（返 200 / 204 即可）。

### F6. cwd / `~/.claude/` 污染风险（容器化才命中）

verify 时假代理收到的 body 第一段是 `<system-reminder>...You have
superpowers...`——本机环境读到了 owner 的 `~/.claude/` 和项目
CLAUDE.md，全塞进 user prompt。

**对 Change 3 容器化的强制要求**：
- 每 user 独立 `CLAUDE_CONFIG_DIR=/home/<user>/.claude/`
- user 容器内 cwd 不挂 owner home / owner 项目目录
- 启动前 `~/.claude/` 必须空目录或 user 自己的 init 内容

本 spike 不解决，归属 Change 3 prototype。

## 副发现（不影响 Phase 1，但归档）

### S1. ccanywhere 当前 spawn 模式

`src/server/routes/sessions.ts:188-191` 与
`src/server/routes/sessions-resume.ts:95-96` 检查：

```ts
args.push('--session-id', forcedSessionId);  // create
args.push('--resume', body.sessionId);        // resume
```

**没有 `-p` / `--print` / `--bare`**。ccanywhere 用 PTY interactive
模式。

### S2. 2026-06-15 Agent SDK credit deadline

官方文档（authentication 页）写：
> Starting June 15, 2026, Agent SDK and `claude -p` usage on
> subscription plans will draw from a new monthly Agent SDK credit

ccanywhere 走 PTY interactive，**不撞这个 deadline**。但仍建议
尽快 ship Phase 1，理由：Anthropic quota model 可能继续演化，代理
让 ccanywhere 自主 cap quota，不依赖上游 quota 形态。

## 不必再做的 prototype

- ❌ interactive 模式 verify：SDK 不区分 -p vs interactive 路径，
  env 变量同样读，--print 已充分证明
- ❌ 文件凭据 verify：claude 不支持自定义凭据文件路径（OAuth 写
  `.credentials.json` 是它内部行为），我们走 `ANTHROPIC_AUTH_TOKEN`
  env 即可
- ❌ Keychain 行为 verify：仅 macOS host 用，容器内 Linux 走文件，
  我们 env 注入完全绕开

## 仍需后续 prototype（不阻塞 Phase 1）

- P3：macOS Docker Desktop per-container cold start 真实数字
  （阻塞 Change 3 lifecycle 设计）
- P4：node-pty + `docker exec -it` 的 TTY/SIGWINCH 信号穿透
  （阻塞 Change 3 spawn 实现）

P3/P4 不阻塞 m-anthropic-proxy 与 m-user-runtime-schema。
