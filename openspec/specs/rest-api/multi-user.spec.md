# REST API: multi-user routes

This is a sibling of `spec.md` covering multi-user (m-multi-user, #44) and
quota (m-quota-cost-tracking, #46) endpoints. Pulled out so the base spec
stays under the openspec md cap. Reference back to `spec.md` for the error
envelope and shared auth conventions.

## Requirements

### Requirement: POST /api/auth/token（m-multi-user）

limited user 通过 token 登录。该路由是 cookie-public（hookEarlyAuth 之前；
登录路径本身不要求已登录），但只接受存在且未过期的 token plaintext。

```
请求: { "token": "<≥32 char plaintext>" }

200 { "ok": true, "user": { "username": "<NFC string>", "kind": "limited" } }
    Set-Cookie: <cookieName>=<token-plaintext>; HttpOnly; SameSite=Lax;
                Max-Age=<ttl-seconds>; [Secure if https]
400 invalid_request   body validation 失败（token < 32 / 缺字段）
401 unauthorized      token verify 失败 / revoked / expired
```

服务端 MUST：

1. `TokenStore.verify(plaintext)` 用 sha256 hash + constant-time 比对。
   verify 必须迭代所有 token（不 early-break）防 timing leak。
2. 命中后 `UserStore.findById(token.userId)` 拿 user；若 `user.kind !==
   'limited'` → 401（防 owner token 误绕）。
3. `UserStore.touchLogin(user.id)` 更新 `lastLoginAt`。
4. cookie value MUST 是 token plaintext（后续请求 hookEarlyAuth 用
   tokenStore.verify 重检）。`maxAge` MUST ≤ token.expiresAt - now，最小
   60 秒（避免立即过期）。

#### Scenario: 合法 token → 颁 cookie

- GIVEN limited user alice，其 active token plaintext T
- WHEN  `POST /api/auth/token { token: T }`
- THEN  状态 `200`，body `{ ok: true, user: { username: 'alice', kind: 'limited' } }`
- AND   `Set-Cookie` 含 `<cookieName>=T`、`HttpOnly`
- AND   `userStore.findById(alice.id).lastLoginAt` 已更新

#### Scenario: token 被 revoke → 401

- GIVEN alice 的 token T 已 `tokenStore.revoke(token.id)`
- WHEN  `POST /api/auth/token { token: T }`
- THEN  状态 `401`，无 Set-Cookie

#### Scenario: 短 body → 400

- WHEN  `POST /api/auth/token { token: "short" }`
- THEN  状态 `400 invalid_request`

### Requirement: GET /api/me/quota（m-multi-user + m-quota-cost-tracking）

返回当前登录 user 的 quota 状态；cookie session 必填。

```
200 {
  "kind": "owner" | "limited",
  "cost":   { "limitUsd": number | null, "usedUsd": number },
  "tokens": { "limit":    number | null, "used":    number }
}
401 unauthorized   无 cookie / cookie 失效
```

owner kind 的 `cost.limitUsd` 与 `tokens.limit` MUST 均为 `null`（不限额）。
limited kind 至少一个 limit MUST 非 null（创建时强制）。`usedUsd` / `used`
是 hook 写回的最新值（自 `user.createdAt` 起累加，详见
`openspec/specs/hooks/spec.md` "quota 单一 enforcement 点"）。

#### Scenario: limited user 返回 quota 对象

- GIVEN limited user alice 持 `cost.limitUsd=5, tokens.limit=100000`，
        当前 used `0`
- WHEN  `GET /api/me/quota`（alice 的 token cookie）
- THEN  状态 `200`，body
        `{ kind: 'limited', cost: { limitUsd: 5, usedUsd: 0 }, tokens: { limit: 100000, used: 0 } }`

#### Scenario: owner 返回 null limits

- GIVEN owner cookie
- WHEN  `GET /api/me/quota`
- THEN  状态 `200`，`cost.limitUsd === null` 且 `tokens.limit === null`

#### Scenario: 无 cookie → 401

- WHEN  `GET /api/me/quota` 不带 cookie
- THEN  状态 `401`

### Requirement: Internal user 管理路由（m-multi-user）

owner 通过 mac CLI（cliToken）调以下端点管理 limited user：

```
POST   /api/internal/users
  body: { "username": "<NFC, /^[\p{L}\p{N} _]{1,32}$/u>",
          "costLimitUsd": number | null,
          "tokensLimit":  number | null,
          "ttlMs": number  // 初始 token 的 ttl，1..7*24*60*60*1000 }
  201 { "user": { id, username, kind: "limited", createdAt, lastLoginAt: null, quota },
        "token": { id, label, createdAt, expiresAt, status: "active" },
        "plaintext": "<32-byte hex; 仅本次返回>" }
  400 invalid_request   username 非法字符 / 两 limit 均 null / ttl 越界
  409 conflict          username 已存在 / fs guard 触发

GET    /api/internal/users
  200 { "users": [ User, ... ] }   // 含 owner + 全部 limited，按 createdAt 排序

PATCH  /api/internal/users/:id/quota
  body: { "costLimitUsd"?: number | null,  // undefined = 不改；null = 清掉
          "tokensLimit"?:  number | null,
          "reset"?: boolean  // true 把 used 清零（保留 limit）}
  200 { "user": User }
  400 invalid_request   设置后两 limit 均 null（limited 必须 ≥1 个非 null）
  404 not_found         user 不存在
  409 conflict          target user.kind === 'owner'（owner 不可设 quota）
```

服务端 MUST：

- `username` 创建前 NFC normalize；fs `<guestProjectsRoot>/<username>/`
  必须不存在，否则 `409 conflict`（防 partial-failure 后残留目录）。
- 创建顺序 `mkdir → users.json` 持久化；users.json 写失败 → rmdir
  回滚已建目录。
- 持久化 token 只存 `sha256(plaintext)`；plaintext **仅** 在 201 response
  返回一次，再也读不到。

#### Scenario: 创建 limited user 返 user + token + plaintext

- GIVEN owner CLI 持有有效 cliToken
- WHEN  `POST /api/internal/users { username: "alice", costLimitUsd: 5,
        tokensLimit: null, ttlMs: 86400000 }`
- THEN  状态 `201`
- AND   `body.user.kind === 'limited'`
- AND   `body.plaintext.length === 64`（32-byte hex）
- AND   后续 `GET /api/internal/users` 列表含 alice

#### Scenario: username 已存在 → 409

- GIVEN alice 已存在
- WHEN  `POST /api/internal/users { username: "alice", costLimitUsd: 1, ttlMs: ... }`
- THEN  状态 `409 conflict`

#### Scenario: PATCH 设两 limit 均 null → 400

- GIVEN alice 当前 `costLimitUsd: 5, tokensLimit: null`
- WHEN  `PATCH /api/internal/users/<alice.id>/quota { costLimitUsd: null }`
- THEN  状态 `400 invalid_request`（清空后两 limit 都 null 不允许）

#### Scenario: PATCH 设 owner quota → 409

- WHEN  `PATCH /api/internal/users/<owner.id>/quota { costLimitUsd: 5 }`
- THEN  状态 `409 conflict`，owner 不可设限

### Requirement: Internal token 管理路由（m-multi-user）

```
POST   /api/internal/tokens
  body: { "userId": "<limited user id>",
          "ttlMs":  number,             // 1..7*24*60*60*1000
          "label":  string | null }
  201 { "token": Token, "plaintext": "<64-char hex>" }
  400 invalid_request   ttl 越界 / userId 缺失
  404 not_found         userId 不存在 / kind !== 'limited'

GET    /api/internal/tokens?user=<username>?
  200 { "tokens": [ Token, ... ] }  // 不返 hash 字段；user 过滤可选

DELETE /api/internal/tokens/:id
  204
  404 not_found   token id 不存在或已 revoked
```

`Token` 形如 `{ id, userId, label, createdAt, expiresAt, status: 'active' | 'revoked' }`，
**不含** `tokenHash`（避免 cliToken 泄露后顺势拿到所有 token hash）。

#### Scenario: 颁发 token 返 plaintext + 持久化

- WHEN  `POST /api/internal/tokens { userId: <alice>, ttlMs: 86400000, label: "phone" }`
- THEN  状态 `201`，`plaintext` 是 64-char hex
- AND   后续 `GET /api/internal/tokens` 含该 token，`label === 'phone'`，
        `status === 'active'`

#### Scenario: ttl 超 7 天 → 400

- WHEN  `POST /api/internal/tokens { userId: <alice>, ttlMs: 8*24*60*60*1000 }`
- THEN  状态 `400 invalid_request`

#### Scenario: revoke 后 verify 立刻失败

- GIVEN active token T
- WHEN  `DELETE /api/internal/tokens/<T.id>`
- AND   alice 用 T plaintext 登录 `POST /api/auth/token`
- THEN  DELETE 返 `204`，login 返 `401`
