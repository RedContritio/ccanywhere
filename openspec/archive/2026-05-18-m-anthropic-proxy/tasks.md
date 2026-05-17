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
- [x] `src/proxy/tokens.ts`: bearer 颁发（5min TTL 默认）+ HMAC-SHA256
      签名 + base64url 编码 + timingSafeEqual 验证 (C2)
- [x] `src/proxy/quota-check.ts`: inline check 接口 + UsageStore 抽象;
      unknown user 走 fail-closed (D7); store impl 留 C3 跟
      metering 一起 (C2)

## 实现 — 转发 + 计量

- [x] `src/proxy/forward.ts`: `POST /v1/messages` 非流式版接受
      query `?beta=...` （spike F1），转发到 api.anthropic.com，
      stainless headers 透传（spike F4），upstream 502/throw 转 502
      verbatim，其他 status code verbatim forward (C3)
- [x] SSE streaming pipe（chunked response 流式 forward）+ usage 累
      积 + reply.hijack + raw.write; 拆到独立 src/proxy/sse.ts 避
      免 forward.ts 超 300 行 lint cap (C4)
- [x] `POST /v1/messages/count_tokens` (allowMeter:false: 仍走 auth+
      quota gate 但不计费，count_tokens 上游免费) (C4)
- [x] `GET /v1/models` 返 404 with `code: reserved` (D6) (C4)
- [x] `src/proxy/metering.ts`: 解析 response usage 字段 + priceFor
      算 USD cost，失败响应不计费 (D3, spike F3) (C3)
- [x] `src/proxy/quota-store.ts`: FileUsageStore 实现 UsageStore
      接口；JSON file backed (0600)，daily UTC reset，limitOf
      callback 注入；Phase 1 不 sync UserStore.quota (BACKLOG
      follow-up) (C3)
- [x] proxy-serve.ts wire: ensureProxyTokenSecret + TokenIssuer +
      FileUsageStore (limitOf 读 users.json sync) + forward deps
      装 buildProxyServer (仅 credentials !== null 时) (C3)
- [x] server.ts wire: BuildProxyOptions.forward 字段 + 条件
      registerForwardRoutes (credentials !== null && forward) (C3)

## 实现 — CLI + 部署

- [x] `src/cli/proxy-serve.ts`: proxy CLI 入口 + 顶层
      `runProxySubcommand` dispatcher (拆出避免 cli.ts 超 300 行
      cap) (C1)
- [x] `src/cli.ts`: 注册 `ccanywhere proxy serve` 子命令 + HELP
      (C1)
- [x] `src/config/schema.ts`: + `proxy.port` (default 62276)
      + `proxy.bindHost` (default 127.0.0.1)；用 zod default 让
      既有 prod config 无需 bump (C1)
- [x] ~~`scripts/install-launchagent-proxy.sh`~~: 不写自动化脚本,
      跟项目约定一致 (主 server 也无 install script, 全靠 docs).
      改为 docs/deployment.md 8.2 plist 模板 + launchctl 命令
      (C5)
- [x] `scripts/proxy-manual-verify.sh`: 起 proxy + 颁发 5min bearer
      + claude --print 走 proxy + log grep 0 leak; `--keep` 保留
      proxy 让 owner dogfood (C5)
- [x] `docs/deployment.md` §8: 代理部署 4 段 (8.1 凭据 / 8.2
      LaunchAgent / 8.3 D7 边界提醒含 quota 共享警示 / 8.4 manual
      verify 用法) (C5)

## 测试

- [x] `src/proxy/tokens.test.ts`: 颁发 / 验证 / 过期 / HMAC 篡改 /
      跨 secret 拒绝 / nonce 唯一性 (C2, 13 测试)
- [x] `src/proxy/quota-check.test.ts`: unknown user / limit null /
      used < limit / used === limit / overshoot / limit 0 (C2, 7 测试)
- [x] `src/proxy/credentials.test.ts`: 文件 mode 校验 + 缺失走
      503 模式 (C1, 7 测试)
- [x] `src/proxy/log-redact.test.ts`: redact rules + self-test
      (C1, 4 测试)
- [x] `src/proxy/server.test.ts`: HEAD / probe + /healthz +
      404 + bodyLimit 10MB (C1, 6 测试)
- [x] `src/proxy/forward.test.ts` (10): auth 3 (无 bearer / 无效
      token / unknown user 401) + quota 1 (429) + forward 4 (header
      替换 + stainless 透传 + ?beta + 502 / 5xx verbatim) + metering
      2 (2xx 记账 + 5xx 不记) (C3)
- [x] `src/proxy/metering.test.ts` (7): opus/sonnet/haiku 单价 +
      cache_read/creation + 未知 model + partial usage NaN-safe
      (C3)
- [x] `src/proxy/quota-store.test.ts` (12): nextDailyReset 边界 +
      unknown user → null + 无限 limit + accumulate + daily lazy
      reset + 持久化 mode 0600 + 重启读回 + corrupt file 走 fresh
      (C3)
- [x] `src/proxy/sse.test.ts` (6): SSE 端到端 (2xx meter 累积 + 5xx
      不 meter) + parser unit (splitSseChunks 边界 + extractSseUsage
      message_start/_delta + 异常输入容错) (C4)
- [x] forward.test.ts 加: GET /v1/models 404 reserved + count_tokens
      auth gate + count_tokens 不计费 (C4)
- [x] retry 不 double-count: forward.test.ts D3 5xx 不计费已覆盖
      (单元层验证 SDK retry 同 prompt 重发 0 累积) (C3)
- [x] e2e manual: scripts/proxy-manual-verify.sh 真起 proxy + curl
      /healthz + claude --print + grep no-leak (C5)

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

- [x] follow-up 已在 proposal.md "后续 follow-up" 段记录
      (m-anthropic-proxy-models / m-anthropic-proxy-multi-key /
      m-proxy-quota-sync), BACKLOG.md 不重复 (Phase 2 启动时按
      ccanywhere 流程建对应 changes/<slug>/) (C5)
- [x] 拆 5 个 commit ship (C1 a2a86ff / C2 ddb8af9 / C3 1a30e5f /
      C4 58b9049 / C5 本笔) (C5)
- [x] archive: mv changes/m-anthropic-proxy →
      archive/2026-05-18-m-anthropic-proxy (C5)
