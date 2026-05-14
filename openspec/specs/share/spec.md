# Share

## Purpose

把某次 cc session 的对话历史导出成静态 HTML 公开 URL，分享给未登录访问
者查看。与 user / device / token 鉴权层**完全解耦** —— share view 路径
不读 cookie、不校验 session、不触发 quota；UUID v4 code 让公开 URL
不可枚举；snapshot HTML 一次性渲染落盘 frozen，配合 immutable cache 让
CDN / browser 永久 cache。

源 ship：m-share-static-export（v1）。

## Requirements

### Requirement: Share code 是 UUID v4

颁发 share 时 code MUST 由 `crypto.randomUUID()` 生成（UUID v4，
122-bit entropy，lowercase hyphenated 36-char）。`/share/:code`
route + DELETE / GET 处理器 MUST 在触碰 filesystem 前用严格 UUID v4
regex 校验 `:code` 参数，拒绝 path-traversal / uppercase / wrong
version / wrong length（任一不匹配 → 404）。

理由：公开 URL **无鉴权**，必须不可枚举；8-char base62 等短码空间
理论上可被 brute-force 扫；UUID v4 把它推到 cosmically impractical。

#### Scenario: 颁发的 code 是 UUID v4 lowercase

- WHEN  POST /api/share 成功
- THEN  返回 `code` 匹配
  `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`

#### Scenario: 路径参数 path-traversal 被 regex 拦截

- WHEN  GET `/share/../etc/passwd`
- THEN  404 text/plain "share not found"
- AND   server 没尝试读文件系统

### Requirement: 公开 view 完全无鉴权

`GET /share/<code>` MUST 与 user/device/token 鉴权层完全解耦：

- 不读 cookie、不读 Authorization header
- 不触发 SessionManager / UserStore / TokenStore 查询
- 不触发 quota 累加
- 仅依赖 ShareStore（filesystem read）

实现：路径不以 `/api/` 或 `/ws/` 开头，`server/auth.ts` onRequest hook
line 119-122 自动放行（"Non-API routes are public"）。

#### Scenario: 无 cookie 也能看 share

- GIVEN client 没有 ccanywhere_session cookie
- WHEN  GET /share/<valid-code>
- THEN  200 + text/html
- AND   返回 HTML 含 cc 对话内容

### Requirement: Snapshot 完全可缓存

`GET /share/<code>` 返回 HTML 时 MUST 设：

- `Content-Type: text/html; charset=utf-8`
- `Cache-Control: public, max-age=31536000, immutable`

snapshot 一旦颁码 frozen（HTML 在 POST /api/share 时一次性 render
落盘）— 与 UUID URI 组合让 URI 成为完美 cache key：相同 URL 任何
时刻同一 byte，CDN 友好。

副作用：share 过期或被 user delete 后，origin 立即 404，但已 cache
的 viewer 仍可看 —— 公开 URL fan-out 是不可撤回的已知 property，
ShareCreateDialog UI 在生成前明示"不可立即撤回"。

#### Scenario: cache headers 正确

- WHEN  GET /share/<valid-code> 任意客户端
- THEN  Cache-Control: public, max-age=31536000, immutable
- AND   Content-Type: text/html; charset=utf-8

### Requirement: 创建 share 仅限 owner / limited 用户分享自己的 session

`POST /api/share { sessionId, ttlMs? }` MUST：

- 未登录 → 401
- session 不存在 或 `session.userId !== req.user.id` → 404（不泄漏
  存在性）
- session 所属 project 已被 hide → 404 `project_gone`
- cc jsonl 文件不可读 → 404 `jsonl_missing`
- body 校验失败 → 400 `invalid_request`
- 成功 → 201 + `{ code, url, expiresAt, createdAt }`

`ttlMs` body 字段语义：

- 整数 > 0：明确 ttl（以毫秒计），服务端将 cap 到 `MAX_TTL_MS`
  (~10 年)
- `null`：永不过期（`expiresAt = null`）
- 缺省：fallback 到 `config.shareTtlMs ?? 7d`

#### Scenario: cross-user 404 不泄漏

- GIVEN alice 拥有 session S
- WHEN  bob 调 POST /api/share { sessionId: S }（bob 登录态）
- THEN  404，错误码不区分 "权限拒绝" vs "不存在"

#### Scenario: ttlMs null 永不过期

- WHEN  POST /api/share { sessionId, ttlMs: null }
- THEN  201 + `expiresAt: null`
- AND   ShareStore 内 record `expiresAt = null` 不进 lazy GC

### Requirement: my-shares list 仅返自己创建的

`GET /api/share/list` MUST：

- 未登录 → 401
- 已登录 → 200 + `{ shares: Array<...> }`，仅含
  `share.createdBy === req.user.id` 的记录，按 `createdAt`
  newest-first 排序

#### Scenario: 不暴露他人 share

- GIVEN alice 已颁码 share Sa；bob 颁码 share Sb
- WHEN  alice GET /api/share/list
- THEN  200 + shares 数组只含 Sa（不含 Sb）

### Requirement: delete 仅 createdBy 本人

`DELETE /api/share/:code` MUST：

- 未登录 → 401
- code 格式无效 → 404
- 找不到记录 或 `record.createdBy !== req.user.id` → 404（不泄漏
  存在性）
- 成功 → 204 + filesystem 上 `<code>.json` + `<code>.html` 都 unlink

#### Scenario: 他人删 share 404

- GIVEN alice 颁码 share Sa
- WHEN  bob DELETE /api/share/<Sa.code>
- THEN  404
- AND   share Sa 文件未被删

### Requirement: Snapshot frozen，不暴露鉴权 identifier

`POST /api/share` 时 server MUST 一次性 render HTML 落盘
（`<configDir>/shares/<code>.html`）+ 写 metadata
`<code>.json`。**view 时 server 不重新渲染**，直接 `readFileSync`
HTML。

Rendered HTML MUST NOT 含：

- sessionId（仅显示 project name + username）
- userId / tokenId / device label
- cookieName / token plaintext
- Claude 的 `thinking` 块（privacy: internal chain-of-thought 不公开）

Rendered HTML 应含：

- project name（user-facing）
- 创建者 username（user-facing）
- createdAt 时间戳
- cc message turn-by-turn 渲染（user / assistant 文本 + tool_use /
  tool_result 折叠）
- `<meta name="robots" content="noindex, nofollow">` 防搜索引擎索引

#### Scenario: thinking 块被丢弃

- GIVEN cc jsonl 含 `{type: 'thinking', thinking: 'INTERNAL_COT'}`
- WHEN  POST /api/share 渲染该 session
- THEN  返回 HTML 不含字符串 "INTERNAL_COT"

#### Scenario: sessionId 不出现在 HTML

- GIVEN session id = `aaaaaaaa-bbbb-cccc-...`
- WHEN  POST /api/share 后 GET /share/<code>
- THEN  HTML body 不含 sessionId

### Requirement: 存储 + lazy GC

`ShareStore` 持久化路径 = `<configDir>/shares/<code>.{json,html}`。
boot 时 `loadAllSync()` 扫所有 `.json` + unlink 过期记录（`expiresAt
< now`）+ 同时 unlink 对应 `.html`。`load(code)` 路径也做 lazy GC
（读到过期 → unlink + return undefined）。**MUST NOT** 跑后台 timer
sweeper。

per-code write chain：同 `<code>` 的 `save` / `delete` 操作 MUST 串行
（与 m-registry-write-queue B10 同模式），跨 code 仍并行。

#### Scenario: boot 时清扫过期 share

- GIVEN `<configDir>/shares/<X>.json` 含 `expiresAt = now - 1000`
- WHEN  ShareStore 构造 + `loadAllSync()`
- THEN  `<X>.json` + `<X>.html` 已 unlink
- AND   返回数组不含 X

### Requirement: shareTtlMs 是 optional schema 字段

`config.shareTtlMs?: number` MUST 是 optional —— 不进必填，缺省时
route handler fallback 到 7d (DEFAULT_TTL_MS)。

理由：避免 schema bump 触发 "Schema bump 必须同步 prod config"
（CLAUDE.md），让现有 prod config.json 无 share 字段也能直接升级
启用 share 子系统。

#### Scenario: config 无 shareTtlMs 字段时

- GIVEN config.json 不含 shareTtlMs
- WHEN  POST /api/share { sessionId, ttlMs 缺省 }
- THEN  201 + `expiresAt = now + 7d`
