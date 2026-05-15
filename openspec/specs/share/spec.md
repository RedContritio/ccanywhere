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

### Requirement: 导出仅含 active path + tool 调用 footer 化（m-share-export-cleanup）

share 导出渲染 jsonl → HTML 时必须：

1. **active path 过滤**：cc 在 jsonl 里写 `{"type":"last-prompt",
   "leafUuid":"..."}` 行，每次 rewind / 新 prompt 追加一条。最后一个
   last-prompt 的 leafUuid 是当前 active tip。从 tip 沿 `parentUuid`
   回溯到 root 即为 active uuid set；off-path 行（dead 分支）不渲染。
2. **fallback**：若 jsonl 完全没有 last-prompt 行（旧 cc 客户端），
   退到顺序渲染（向后兼容）。
3. **tool 调用 body 完全不渲染到 HTML**：tool_use 的 name / input、
   tool_result 的 content 都**不**进入输出 HTML——不是隐藏，是源码
   里就没有。保留的只有 tool_use_id（用于 footer 计数去重）。
4. **以 user 为段边界合并 assistant**：在两个 real user prompt 之间，
   多个连续 assistant rows + 中间的 synthetic user-role tool_result
   rows 全部合并成**一个** assistant article。混合 user message
   （text + tool_result）：text 部分照渲染为新 user message（关闭当前
   assistant 段），tool_result 部分仅为 footer 计数。
5. **tools used footer**：合并后的 assistant article 末尾追加
   `<div class="tools-footer">{N} tool[s] used</div>`，N = 该段内
   tool_use_id 去重后总数（assistant 自己的 tool_use `id` 与
   user-role tool_result 的 `tool_use_id` 配对算 1，不双计）。

#### Scenario: last-prompt.leafUuid 驱动 active path 过滤

- GIVEN jsonl 含 user u1 → assistant u2(parent=u1, "DEAD") +
        assistant u3(parent=u1, "ACTIVE") + user u4(parent=u3) +
        `{type:'last-prompt', leafUuid:'u4'}`
- WHEN  renderShareHtml 处理
- THEN  输出含 "ACTIVE"，不含 "DEAD"

#### Scenario: 多 last-prompt 取最后一个（rewind 累积）

- GIVEN 同一 jsonl 内先后写两条 last-prompt（leafUuid=u2 然后 u3）
- WHEN  renderShareHtml 处理
- THEN  active tip 为 u3，u2 分支若 off-path 则不渲染

#### Scenario: 无 last-prompt 时退到顺序渲染（向后兼容）

- GIVEN jsonl 不含 last-prompt 行（旧 cc session）
- WHEN  renderShareHtml 处理
- THEN  所有 user / assistant 行按 jsonl 顺序渲染（现行 v1 行为）

#### Scenario: synthetic user-role tool_result 整行不渲染

- GIVEN assistant message 内含 tool_use(id=t1) + 紧接 user-role
        message 内含 tool_result(tool_use_id=t1, content="some output")
- WHEN  renderShareHtml 处理
- THEN  输出含 1 个 `<article class="msg assistant">`，无独立 user
        article
- AND   输出**不**含 "some output"、`<details>`、`<pre>` 等 tool body
        痕迹
- AND   该 assistant article 末尾仅有 `<div class="tools-footer">1
        tool used</div>`

#### Scenario: 多 assistant rows 合并为单 article（以 user 为段边界）

- GIVEN user "do something" → assistant(text="first", tool_use t1) →
        user(tool_result t1) → assistant(text="second", tool_use t2) →
        user(tool_result t2) → assistant(text="final") → user "next"
- WHEN  renderShareHtml 处理
- THEN  恰好 2 个 user article + 1 个 assistant article（中间 3 个
        assistant rows 合并）
- AND   assistant article 含 "first" / "second" / "final" 全部 text
- AND   仅 1 个 `tools-footer` 显示 "2 tools used"

#### Scenario: 混合 user message 拆分（text 留 user，tool_result 仅计数）

- GIVEN assistant(u2 含 tool_use t1) + user(u3 含 text + tool_result
        t1)
- WHEN  renderShareHtml 处理
- THEN  user u3 的 text 部分输出为新 user article
- AND   user u3 的 tool_result content **不**出现在 HTML 中
- AND   tool_use_id t1 计入 u2 assistant article 的 footer

#### Scenario: footer 计数按 tool_use_id 去重

- GIVEN assistant 含 2 个 tool_use(id=A, id=B)，user 含对应
        tool_result(tool_use_id=A, tool_use_id=B)
- WHEN  renderShareHtml 处理
- THEN  footer 显示 "2 tools used"（不是 4 — A 和 B 各算 1）
