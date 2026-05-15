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

### Requirement: 用户与令牌（m-multi-user + m-user-symmetric）

服务端 MUST 实现 owner/user 二元身份模型 + 令牌登录。m-user-symmetric
reframe 把 m-multi-user 的 `'owner' | 'limited'` 字面值改名为
`'owner' | 'user'`（"limited" 描述不再成立——所有 user 在数据层对称，
policy 才区分），同时数据层去 owner-special 假设：device.userId 必填、
任意 user 可走 token 登。policy 层仍 enforce `kind === 'owner'` 的有：
WebAuthn pair-init + hook quota check（owner 跳过）。

- 用户首次启动时 MUST 自动建一个 owner（`username='owner'`），且 owner
  唯一。
- owner MUST 通过 WebAuthn pair → cookie session 流程；device 当前 pair
  policy 在 mac CLI approve 时一律赋 `device.userId = owner.id`（数据层
  允许任意 userId，但 pair-time policy 暂仅许 owner）。
- 普通 user MUST 由 owner CLI 显式创建（`ccanywhere user create`），首选
  通过 token 登录；owner 也可自签 token 登入（admin / 自动化路径）。
- `POST /api/auth/token { token }` MUST 用 sha256 hash + constant-time 比对
  验 token plaintext；user kind 不限。成功后 set cookie（value 即 token
  plaintext，ttl ≤ token.expiresAt），返回 `{ ok: true, user:
  { username, kind } }`；失败 401。
- `POST /api/auth/webauthn/login-init` MUST 拒绝 device.userId dangling
  的请求（403：device 关联的 user 已被删除）。**MUST NOT** hardcode
  `kind === 'owner'`——pair-time policy 已是 enforcement 点；这里只校验
  数据完整性，便于将来 pair policy 扩展。
- 每个 request 的 cookie value MUST 通过 hookEarlyAuth 解析：先 try
  deviceStore.authenticateSession（device-session）；不命中再 try
  tokenStore.verify（token-session）。两者都不命中 → 401。`req.user`
  字段被填充以让下游 handler（sessions / ws / quota）使用。
- user.quota 字段（`cost.limitUsd` / `cost.usedUsd` / `tokens.limit` /
  `tokens.used`）owner 端 limits 均为 null（不限）；普通 user 端至少一个
  非 null（创建时强制）。`GET /api/me/quota` 返回当前 user 的 quota 状态。
- `GET /api/auth/me` MUST 返回统一形状 `{ id, label, kind, lastUsedAt }`
  让 web 客户端不区分身份层判定登录态：
  - device cookie → `{ id: device.id, label: <device.userId 对应 user.username
    或 fallback "owner">, kind: <user.kind 或 'owner'>,
    lastUsedAt: device.lastUsedAt }`（数据层支持任意 user kind 持有
    device，但当前 pair policy 始终 owner）
  - token cookie → `{ id: user.id, label: user.username, kind: user.kind,
    lastUsedAt: user.lastLoginAt }`
  - 无 cookie → 401
- 旧 `users.json`（kind === 'limited'）MUST 在 UserStore.load 时 in-memory
  migrate 成 'user' 并 persist 一次，保持鉴权可用性（已签发 token 不
  作废，已登 cookie 仍有效）。

### Requirement: 用户级偏好与活跃 session（m-user-prefs）

User 记录 MUST 含两个跨设备同步字段：

- `preferences: UserPreferences` —— UI 偏好对象（首期含 `toolbar?:
  ToolbarLayout`，未来可扩 theme override 等）。**owner 与 user 同等
  支持**。
- `lastActiveSessionId: string | null` —— 用户最后选中的 cc session id
  （ephemeral state，与 preferences 语义分离）。客户端访问 /workspace 时
  作为默认选中，stale id 由客户端 join 实时 sessions list 时 silently
  忽略。

API（cookie-gated，owner / user 同等可用）：

```
GET  /api/me/preferences       → 200 UserPreferences (默认 {})
PUT  /api/me/preferences        body { toolbar?: ToolbarLayout | null }
                                → 200 UserPreferences  (null = 清掉回默认)
                                → 400 invalid_request

GET  /api/me/active-session    → 200 { sessionId: string | null }
PUT  /api/me/active-session     body { sessionId: string | null }
                                → 200 { sessionId }
```

`ToolbarLayout` 字段约束（服务端 zod 校验）：

- `rows ∈ [1, 3]`, `cols ∈ [3, 8]`
- `cells.length === rows × cols`，每 cell 为 `ToolbarKey` 或 `null`
- 每个 `ToolbarKey.id` 在 layout 内唯一
- `action ∈ {'plain', 'ctrl-letter', 'toggle-sticky-ctrl'}`
- `'ctrl-letter'` 的 `payload` MUST 匹配 `/^[a-z]$/`

旧 `users.json`（pre-m-user-prefs，无 `preferences` / `lastActiveSessionId`
字段）load 时 MUST 默认为 `{}` / `null`（持久化迁移在 load 路径完成）。

#### Scenario: 颁发后默认空

- GIVEN owner 自动建 或 user 通过 CLI 创建
- WHEN  `GET /api/me/preferences` + `GET /api/me/active-session`
- THEN  分别返 `{}` 与 `{ sessionId: null }`

#### Scenario: PUT preferences { toolbar: null } 清掉

- GIVEN 已存 toolbar layout
- WHEN  `PUT /api/me/preferences { toolbar: null }`
- THEN  200，后续 `GET /api/me/preferences` 返 `{}`

#### Scenario: 旧 users.json 升级时无 preferences 字段不破坏 load

- GIVEN 磁盘上 users.json 来自 pre-m-user-prefs 版本（无 preferences
  / lastActiveSessionId 字段）
- WHEN  UserStore 启动 load
- THEN  内存中 user 记录的 `preferences === {}` 与 `lastActiveSessionId === null`

#### Scenario: token login 颁 cookie

- GIVEN user alice 已由 owner 创建，token plaintext 已颁
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

- GIVEN user alice `createdAt = T0`，`cost.usedUsd = $4.50`，
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

### Requirement: 登出保留配对身份（m-logout-preserve-pairing）

前端 auth store 把**活动会话** (`deviceId / label / kind / verifiedAt`)
与**已存凭证缓存** (`ownerDeviceId / ownerLabel / limitedUsers[]`) 分开。

凭证缓存模型：

- **owner slot** 单 slot：`ownerDeviceId / ownerLabel`，一台设备一个
  webauthn 配对。
- **limited slot** 列表：`LimitedUserRecord[]`，每个 user 含 `username` +
  `tokens: { token, expiresAt }[]`。同一 user 可累积多 token，token
  dedup-by-plaintext upsert。`expiresAt` 是 client-side 估算
  (`Date.now() + DEFAULT_TOKEN_TTL_MS`)，仅用于排序"试最长 lifetime 优先"。

操作语义：

- **clearSession**：清活动会话，保留 owner + user 所有 stored 凭证。
  RequireAuth 检测 `deviceId === null` 自动跳 `/login`。
- **unpair**：全清。测试 / 显式重置用。
- **forgetOwnerCredential**：仅清 owner slot（若 active 是 owner，同时
  清 active），保留 limitedUsers。
- **forgetToken(userId, token)**：仅删某 user 的某一个 token。
- **forgetLimitedUser(userId)**：删该 user 整条记录（若 active 是该
  user，同时清 active）。
- **token-login 错误分类**：`runTokenLogin` 返 `TokenLoginResult` —
  `invalid`（server 401，明确拒）/ `transient`（fetch throw / 5xx /
  其他网络错）/ `ok`。

调用点契约：

- workspace 顶部「登出」按钮 → `logoutServer` + `clearSession`
- api.ts 全局 401 → `clearSession`（依靠 RequireAuth 自动跳 /login）
- `runLogin` 失败（owner 401） → `forgetOwnerCredential`，**保留** 所有
  user
- 一键 token-login 序列尝试某 user 的 token：
  - `invalid` → `forgetToken`，试下一个
  - `transient` → 退让重试 4 次（500ms / 1s / 2s / 4s），仍 transient
    则**永不删 token**，停止序列，提示「网络异常」
  - 全部 token 序列 `invalid` 用完 → **保留 user 记录**（tokens 列空），
    提示「输入新 token」

#### Scenario: 主动登出后保留所有已存凭证

- GIVEN owner 已 pair (`ownerDeviceId='dev-1'`) 且曾以 alice token 登过
        (`limitedUsers=[{userId:'alice-uid', tokens:[{token:T1}]}]`)
- WHEN  user 点 workspace 「登出」
- THEN  服务端 cookie revoke (`/api/auth/logout` 204)
- AND   active session 全 null (`deviceId / kind / verifiedAt`)
- AND   `ownerDeviceId='dev-1'` 与 alice 的 token 列表完整保留
- AND   /login 页同时显示「用本机生物识别登入」与 alice 的快捷登录按钮

#### Scenario: 401 fallback 触发 RequireAuth 自动跳 /login

- GIVEN owner 在 workspace 操作中，server-side cookie 已过期
- WHEN  任一 `/api/*` 请求收到 401
- THEN  `clearSession()` 调（active 全 null，stored 不动）
- AND   `RequireAuth` 检测 `deviceId === null` 自动 `<Navigate to="/login">`
- AND   /login 页基于 stored 渲染（webauthn 入口 + 已存 user 列表）

#### Scenario: webauthn credential revoke 触发硬解配对

- GIVEN owner 用户存有 deviceId，但服务端已对该 device 调 revoke
- WHEN  user 在 /login 页点「用本机生物识别登入」
- AND   `runLogin` 因 server 401 返 false
- THEN  `forgetOwnerCredential()` 调（仅清 owner stored slot；若 active
        是 owner 则同时 clear active）
- AND   `limitedUsers` 列表不动 — 之前以 limited token 登过的用户仍可在
        /login 页选择
- AND   /login 页 owner 入口消失，但 user 列表保留

#### Scenario: 多 token-per-user 自动按 expiresAt 降序尝试

- GIVEN alice 有两个 stored token T1 (`expiresAt=now+1d`) 与 T2
        (`expiresAt=now+6d`)，server 已 revoke T2 但 T1 仍 valid
- WHEN  user 在 /login 点 alice 按钮
- THEN  先试 T2 → 退让重试上限后均返 `invalid`
- AND   `forgetToken('alice-uid', T2)` 调（仅删 T2）
- AND   接着试 T1 → 返 `ok` → `setLimitedSession` + 跳 /workspace

#### Scenario: 网络异常不删 token，指数退让后给用户重试机会

- GIVEN alice 有 token T1，网络断连
- WHEN  user 点 alice 按钮
- AND   `runTokenLogin` fetch 抛 → 返 `{reason: 'transient'}`
- THEN  退让 500ms / 1s / 2s / 4s 重试（共 4 次尝试）
- AND   所有尝试均 transient → 停止序列尝试，T1 **保留**
- AND   UI 显示「网络异常，未能完成 alice 的登录」错误 + 「返回」link

#### Scenario: 所有 token 都失效后保留 user record

- GIVEN alice 有 1 个 token T1，server 已 revoke
- WHEN  user 点 alice 按钮
- AND   T1 退让重试均 `invalid` → `forgetToken` 调，alice.tokens 变空
- THEN  循环结束，alice 记录**保留**（设备仍记得"曾以 alice 登录过"）
- AND   /login 页 alice 按钮仍存在（无 token count badge）
- AND   error 提示「alice 的已存 token 都已失效，请输入新 token」+
        主按钮直跳 token-input

#### Scenario: 双轨设备同时支持 owner + 多 user

- GIVEN 同一设备先后用作 owner 配对、以 alice 登录、以 bob 登录
- WHEN  /login 渲染 idle 区
- THEN  顶部显示「用本机生物识别登入」(owner)
- AND   下方依次显示 alice / bob 按钮，每个标 `{count} token` (仅当 >1)
- AND   底部「用新 token 登录」link 可切到 token 输入
