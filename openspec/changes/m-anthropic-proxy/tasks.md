# Tasks: m-anthropic-proxy

## 前置 prototype

- [x] P2: claude 走 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
      验证（see spike-p2-verify.md）

## 实现 — 代理 server core

- [x] `src/proxy/credentials.ts`: 启动时读
      `~/.config/ccanywhere/anthropic-credentials.json`，校验 mode
      0600，加载到内存。文件不存在 → 503 模式启动 (C1)
- [x] `src/proxy/log-redact.ts`: pino redact rules + 启动 self-test
      （写一条假 auth log，grep 必须看不到原 token）(C1)
- [x] `src/proxy/server.ts`: fastify 主入口，bodyLimit 抬到 10MB
      （spike F2）+ /healthz + setNotFoundHandler / setErrorHandler
      (C1, 转发路由 C3+)
- [x] `HEAD /` route 返 200（spike F5 启动 probe）(C1)
- [ ] `src/proxy/tokens.ts`: bearer 颁发（5min TTL）+ 校验 + 解析
      userId
- [ ] `src/proxy/quota-check.ts`: inline check，超额返 429

## 实现 — 转发 + 计量

- [ ] `src/proxy/forward.ts`: `POST /v1/messages` 接受 query
      `?beta=...` （spike F1），转发到 api.anthropic.com，stainless
      headers 透传（spike F4）
- [ ] SSE streaming pipe（chunked response 流式 forward）
- [ ] `POST /v1/messages/count_tokens` 同上简化版（无 SSE）
- [ ] `GET /v1/models` 返 404 with reserved 提示（D6）
- [ ] `src/proxy/metering.ts`: 解析 response usage 字段，按 userId
      记账（失败响应不计费，spike F3）

## 实现 — CLI + 部署

- [x] `src/cli/proxy-serve.ts`: proxy CLI 入口 + 顶层
      `runProxySubcommand` dispatcher (拆出避免 cli.ts 超 300 行
      cap) (C1)
- [x] `src/cli.ts`: 注册 `ccanywhere proxy serve` 子命令 + HELP
      (C1)
- [x] `src/config/schema.ts`: + `proxy.port` (default 62276)
      + `proxy.bindHost` (default 127.0.0.1)；用 zod default 让
      既有 prod config 无需 bump (C1)
- [ ] `scripts/install-launchagent-proxy.sh`: 安装 proxy
      LaunchAgent plist
- [ ] `scripts/proxy-manual-verify.sh`: 一行启动 proxy + 颁发
      test bearer + `claude --print` 走 proxy 验证完整链路
      （D7：ship 后无真实流量，靠此脚本手动 verify）
- [ ] `docs/deployment.md`: + 代理部署段 + 凭据文件说明 + 说明
      owner 路径**不**经代理（D7），仅 Phase 2 user 容器化才走

## 测试

- [ ] `src/proxy/tokens.test.ts`: 颁发 / 验证 / 过期 / 重放防护
- [x] `src/proxy/credentials.test.ts`: 文件 mode 校验 + 缺失走
      503 模式 (C1, 7 测试)
- [x] `src/proxy/log-redact.test.ts`: redact rules + self-test
      (C1, 4 测试)
- [x] `src/proxy/server.test.ts`: HEAD / probe + /healthz +
      404 + bodyLimit 10MB (C1, 6 测试)
- [ ] `src/proxy/forward.test.ts`: mock upstream，验证
  - `?beta=true` 透传
  - stainless headers 透传
  - SSE chunked 转发
  - 5xx 不计费
  - retry 不 double-count（同 idempotency key 两次）
- [ ] `src/proxy/metering.test.ts`: usage 解析 + 按 user 记账
- [ ] `src/proxy/quota-check.test.ts`: 超额 429 + 未超 200
- [ ] e2e: 起 proxy + curl 真打 `/v1/messages` (mock upstream)
      验完整链路

## 验证

- [ ] `pnpm typecheck:all` 全过
- [ ] `pnpm lint` 全过
- [ ] `pnpm lint:md` 全过
- [ ] `pnpm test` 全过
- [ ] `pnpm build:all` 成功
- [ ] `scripts/proxy-manual-verify.sh` 跑通（手动 verify
      完整链路，D7：ship 后没真实流量）
- [ ] 代理日志 grep 任何 token 字符串 → 0 命中
- [ ] kill 代理后 manual-verify 脚本 fail（确认没旁路）
- [ ] **owner 路径零回归 verify**：owner spawn 一个 ccanywhere
      session，claude 调用仍直连 `api.anthropic.com`（**不**带
      `ANTHROPIC_BASE_URL`），session 正常完成。确认本 Change
      不副作用 owner（D7）
- [ ] 主 ccanywhere server `launchctl kickstart` healthz 200
      （确认本 Change 不影响主进程）

## BACKLOG + Commit

- [ ] BACKLOG.md 添加 m-anthropic-proxy-models (reserved follow-up)
- [ ] BACKLOG.md 添加 m-anthropic-proxy-multi-key (reserved
      follow-up)
- [ ] commit (单个 logical change，message 含 spike 路径引用)
