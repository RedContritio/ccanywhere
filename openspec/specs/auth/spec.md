# Auth

## Purpose

ccanywhere 把 cc 暴露成 web 入口；web 端用户必须先「配对」一台设备（浏览器
+ 平台认证器，如 mac Touch ID / iOS Face ID / 安卓指纹），由 mac 上的所有
者手动 approve 后才能登入。这避免了"任何拿到 URL 的人都能登"的风险，同时
完全摆脱了"长 token 字符串复制粘贴"的体验。

ccanywhere 有三个独立的信任域：

- **web 设备 cookie**（HttpOnly session cookie）：人类用户与浏览器之间，由
  WebAuthn pair + login 流程颁发；用于除 hook 与内部 RPC 路由之外的所有
  HTTP/WS 入口。
- **内部 hook token**（启动时随机生成的 32 字节，不持久化）：仅 cc 子进程
  的 `/api/hook/*` 路由接受。
- **CLI token**（`~/.config/ccanywhere/cli-token`，mode 0600）：仅 mac CLI
  子命令通过 127.0.0.1 调 `/api/internal/*` 时使用。

任一 token 域 MUST NOT 授权另一域。

## Requirements

### Requirement: 设备配对（Pair）

设备配对 MUST 走 WebAuthn registration，并 MUST 由 mac CLI approve 后才生效。

完整流程：

1. 浏览器 `POST /api/auth/register-init { label }` →
   服务端创建 pending 记录（status=`awaiting-registration`），调
   `generateRegistrationOptions` 生成 challenge，返回
   `{ pendingId, options }`。
2. 浏览器 `navigator.credentials.create({ publicKey: options })` 触发平台
   认证器 → 拿到 attestation。
3. 浏览器 `POST /api/auth/register-complete { pendingId, attestation }` →
   服务端 `verifyRegistrationResponse`；通过后把 credential 存到内存的
   `pendingCredentials` map，pending 状态 `awaiting-registration` →
   `awaiting-approval`。
4. mac 终端 `ccanywhere approve` → 列出 awaiting-approval pending → 选择 →
   `POST /api/internal/pending/:id/approve` → 服务端把 credential 写入
   持久化 device 表 + 颁发 sessionId 写入 pending 的 `issuedSessionId`。
5. 浏览器 long-poll `GET /api/auth/register-status?pendingId=…` →
   返回 `{ status: 'approved', deviceId }` 同时 `Set-Cookie:
   ccanywhere_session=<id>; HttpOnly; SameSite=Lax`。

pending 记录 30 分钟过期后被清理；过期或显式 `DELETE
/api/internal/pending/:id` 都把 status 设为 rejected，浏览器下一轮 poll
会收到 `{ status: 'rejected' }`。

#### Scenario: register-init 创建 pending 并返回 challenge

- GIVEN 没有任何已注册设备
- WHEN  `POST /api/auth/register-init { label: "iPhone" }`
- THEN  状态 `201`，body 含 `pendingId` 和 `options`（含 `challenge`、
  `rp.id` 等字段，rpID = `webOrigin` 的 hostname）

#### Scenario: register-complete 在错 pendingId 时返 404

- GIVEN 不存在该 pendingId
- WHEN  `POST /api/auth/register-complete { pendingId: "ghost", attestation }`
- THEN  状态 `404 not_found`

#### Scenario: register-status 在 approve 前返回 awaiting-approval

- GIVEN pendingId 已 register-complete 但 approve 未发生
- WHEN  `GET /api/auth/register-status?pendingId=…`
- THEN  状态 `200`，body `{ "status": "awaiting-approval" }`，**不**带 cookie

#### Scenario: register-status 在 approve 后返回 approved + 设 cookie

- GIVEN approve 已发生
- WHEN  `GET /api/auth/register-status?pendingId=…`
- THEN  状态 `200`，body `{ "status": "approved", "deviceId": "<uuid>" }`，
  响应头含 `Set-Cookie: ccanywhere_session=…; HttpOnly; SameSite=Lax`

### Requirement: 设备登入（Login）

已配对设备 MUST 用 WebAuthn assertion 登入，颁发新 session cookie。

1. 浏览器 `POST /api/auth/login-init { deviceId }` → 服务端
   `generateAuthenticationOptions` + `createLoginChallenge`，返回
   `{ tempId, options }`。
2. 浏览器 `navigator.credentials.get(options)` → assertion。
3. 浏览器 `POST /api/auth/login-complete { tempId, assertion }` →
   服务端 `consumeLoginChallenge` + `verifyAuthenticationResponse`；通过
   后 bumpDeviceCounter + issueSession + `Set-Cookie`。

login challenge tempId 5 分钟过期；consume 是一次性的。

#### Scenario: login-init 对未知 deviceId 返 404

- GIVEN deviceId 不存在或 `status=revoked`
- WHEN  `POST /api/auth/login-init { deviceId: "ghost" }`
- THEN  状态 `404 not_found`

#### Scenario: login-complete 对 verify 失败的 assertion 返 401

- GIVEN tempId 合法但 assertion 签名验证失败
- WHEN  `POST /api/auth/login-complete { tempId, assertion }`
- THEN  状态 `401 verification_failed`

### Requirement: 三 token 域隔离

服务端 MUST 按 url 前缀路由认证：

| 路径前缀 | 认证方式 |
|---|---|
| `/api/hook/*` | `Authorization: Bearer <internalHookToken>` |
| `/api/internal/*` | `Authorization: Bearer <cliToken>` |
| `/api/auth/{register-init,register-complete,register-status,login-init,login-complete}` | 公开（流程自带证明） |
| `/api/auth/me`、`/api/auth/logout`、其它 `/api/*`、`/ws/*` | `Cookie: ccanywhere_session=<id>` |
| `/healthz`、SPA 静态资源 | 公开 |

任一 token 域 MUST NOT 授权另一域。

#### Scenario: cookie 在 hook 路由上被拒绝

- GIVEN 合法 session cookie
- WHEN  `POST /api/hook/<sid>/Stop`
- THEN  响应 MUST 为 `401 unauthorized`

#### Scenario: hook token 在用户路由上被拒绝

- GIVEN 用 `Authorization: Bearer <internalHookToken>` 请求 `GET /api/projects`
- WHEN  服务端处理
- THEN  响应 MUST 为 `401 unauthorized`

#### Scenario: cli token 在 hook 与用户路由上都被拒绝

- GIVEN 用 `Authorization: Bearer <cliToken>` 请求 `GET /api/projects`
- WHEN  服务端处理
- THEN  响应 MUST 为 `401 unauthorized`

#### Scenario: cookie 在 internal 路由上被拒绝

- GIVEN 合法 session cookie
- WHEN  `GET /api/internal/devices`
- THEN  响应 MUST 为 `401 unauthorized`

### Requirement: 公开路由

`/healthz` MUST 无需认证可达，MUST 返回 `200 { "ok": true }`。
`/api/auth/{register-init,register-complete,register-status,login-init,login-complete}`
MUST 也无需 cookie——它们是配对/登入流程的入口。

#### Scenario: healthz 公开

- GIVEN 不带任何凭证
- WHEN  `GET /healthz`
- THEN  状态 `200`，body `{"ok": true}`

### Requirement: WebSocket upgrade 拒绝时清理 socket

WebSocket upgrade 请求认证失败时，服务端 MUST 直接写裸 HTTP `401` 响应附
`Connection: close` 并立即销毁底层 TCP socket，不要走框架的 graceful reply
路径。这是为了避免 `app.close()` 被一个挂起的 keep-alive socket 阻塞。

#### Scenario: 缺 cookie 的 upgrade 立刻断连

- GIVEN 一个 WebSocket upgrade 请求不带 `Cookie`
- WHEN  服务端处理
- THEN  客户端收到 HTTP `401`
- AND   底层 socket 在 1 秒内关闭
- AND   `app.close()` 在正常超时内返回

### Requirement: 设备撤销

mac CLI `ccanywhere revoke <device-id>` MUST 调用
`DELETE /api/internal/devices/:id`，服务端 MUST：

1. 把该 device 的 status 设为 `revoked`，持久化到 `devices.json`。
2. 删除该 device 的所有 sessions（cookie 立即失效）。
3. 后续 `POST /api/auth/login-init { deviceId }` 必须返 404。

#### Scenario: 撤销后 cookie 失效

- GIVEN 设备 D 有合法 session cookie，正在用 `/api/projects`
- WHEN  CLI 执行 `ccanywhere revoke D.id`
- AND   浏览器再次 `GET /api/projects`
- THEN  服务端响应 `401 unauthorized`

### Requirement: 用户与令牌（m-multi-user）

服务端 MUST 实现 owner/limited 二元用户模型 + 令牌登录：

- 用户首次启动时 MUST 自动建一个 owner（`username='owner'`），且 owner 唯一。
- owner MUST 走 WebAuthn pair → cookie session 流程（同上）；device 全部
  归属 owner（`device.userId = owner.id`）。
- limited user MUST 由 owner CLI 显式创建（`ccanywhere user create`），
  通过 token 登录而非 WebAuthn。
- `POST /api/auth/token { token }` MUST 用 sha256 hash + constant-time 比对
  验 token plaintext；成功后 set cookie（value 即 token plaintext，ttl ≤
  token.expiresAt），返回 `{ ok: true, user: { username, kind } }`；
  失败 401。
- `POST /api/auth/webauthn/login-init` MUST 拒绝 device.userId 不指向
  owner 的请求（403）。limited user 没有 device 走不进该路径，本检查是
  defensive。
- 每个 request 的 cookie value MUST 通过 hookEarlyAuth 解析：先 try
  deviceStore.authenticateSession（device-session）；不命中再 try
  tokenStore.verify（token-session）。两者都不命中 → 401。`req.user`
  字段被填充以让下游 handler（sessions / ws / quota）使用。
- user.quota 字段（`cost.limitUsd` / `cost.usedUsd` / `tokens.limit` /
  `tokens.used`）owner 端 limits 均为 null（不限）；limited 端至少一个
  非 null（创建时强制）。`GET /api/me/quota` 返回当前 user 的 quota 状态。
- `GET /api/auth/me` MUST 返回统一形状 `{ id, label, kind, lastUsedAt }`
  让 web 客户端不区分身份层判定登录态：
  - owner cookie → `{ id: device.id, label: device.label,
    kind: 'owner', lastUsedAt: device.lastUsedAt }`
  - limited cookie → `{ id: user.id, label: user.username,
    kind: 'limited', lastUsedAt: user.lastLoginAt }`
  - 无 cookie → 401

#### Scenario: token login 颁 cookie

- GIVEN limited user alice 已由 owner 创建，token plaintext 已颁
- WHEN  浏览器 `POST /api/auth/token` body `{ token }`
- THEN  返回 200 + Set-Cookie 含 token plaintext，maxAge ≤ token.expiresAt
- AND   后续 `GET /api/me/quota` 返回 alice 的 quota

### Requirement: user.quota 累加自 user.createdAt（m-quota-cost-tracking）

`user.quota.cost.usedUsd` 与 `user.quota.tokens.used` MUST 通过
`ccusageCalc(jsonlPath, sinceTimestamp = user.createdAt)` 重新计算并写回，
**不是** 增量累加。这保证：

- token 轮换 / revoke / re-issue 不重置 quota（quota 是 user-scoped，
  与 token lifecycle 解耦）。
- 多 session 并发不会因为 race 导致 used 双计：每次 hook fire 都从
  user.createdAt 全量重读 jsonl，结果是幂等的。
- cost 公式：每个 `type='assistant'` 且 `timestamp >= user.createdAt` 的
  `message.usage` 行按 model `priceFor()` 累加 `(input + output +
  cache_read + cache_creation tokens) × rate / 1_000_000`。

owner 的 `quota.cost.usedUsd` / `quota.tokens.used` MUST NOT 被服务端写入
（owner 不限额；hook handler 在 quota check 处早退 owner 路径，绕开 persist）。

#### Scenario: token 轮换不重置 quota

- GIVEN limited user alice `createdAt = T0`，`cost.usedUsd = $4.50`，
        已颁 token T1 + revoked
- WHEN  owner 给 alice 颁新 token T2（同 user.id，新 expiresAt）
- AND   alice 用 T2 登录 + 触发 UserPromptSubmit
- THEN  `userStore.findById(alice.id).quota.cost.usedUsd` 仍 ≥ $4.50
- AND   ccusageCalc 重读 jsonl since=T0，不是 token.createdAt

#### Scenario: owner usage 不持久化

- GIVEN owner session，jsonl 含 $10 真实 usage
- WHEN  POST `/api/hook/<sid>/UserPromptSubmit`
- THEN  `userStore.findById(owner.id).quota.cost.usedUsd === 0`（pre-quota
        初始值保留）
