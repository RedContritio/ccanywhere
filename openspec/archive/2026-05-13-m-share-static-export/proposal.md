---
status: planned
---

# Proposal: m-share-static-export — programmatic session 静态 HTML 导出

## Intent

用户在 web 端把某次 cc session 的对话历史（cc jsonl）导出成静态 HTML
公开 URL，与 user / device / token 鉴权层**完全解耦**，可分享给未登
录的访问者查看。

出处：`openspec/archive/2026-05-11-m-multi-user/proposal.md` §Share —
v0 cc 子进程 LLM 渲染方案被风险评审否决（不稳定 / 反向 quota UX），
programmatic 路径作为 v1 实施目标。

## 决策

### D1. 渲染形态 = programmatic markdown render

读 cc jsonl，按 message-turn 结构 (`user` / `assistant` / `tool_use` /
`tool_result`) 渲染为 markdown→HTML（code block / inline code 用
syntax highlighter）。**非** xterm replay（cc TUI 视觉 stream 形态不
适合 non-cc-user viewer）。

### D2. Share code = UUID v4

`crypto.randomUUID()`（Node 18+ / Web Crypto 原生，无需 npm dep），
122-bit entropy ≈ 5.3×10³⁶ 空间。URL 路径 `/share/<uuid>`。

理由：公开 URL **无鉴权**，必须不可枚举。8-char base62 (~218T) 看似
大但理论上 brute-force enumerate 可能；UUID v4 paranoid-safe，让 share
URL 真正"知道才能看"。URL 长但 user 复制时一键不打字，cost 可忽略。

### D3. TTL 默认 7 天，选项 1d / 7d / 30d / never

`shareTtlMs` 加入 `config.json` schema **作 optional 字段**（缺省
fallback 7d）—— 不进必填，避免 schema bump 同步 prod config 成本
（per `CLAUDE.md` "Schema bump 必须同步 prod config" + m-multi-user
`guestProjectsRoot` 教训）。

### D4. 权限：owner + limited 都可 share **自己**的 session

`POST /api/share` body `{ sessionId, ttlMs? }` MUST：

- session 存在且 `session.userId === req.user.id` → 颁码 → 201
- 否则 → 404（不泄漏存在性）
- limited 用户的 quota 不会因 share 改变（share view 不消耗 quota，
  无 cc 进程参与）

`GET /share/<code>` MUST 无鉴权（任何人 / 未登录访问者都可看）。

### D5. 存储 = `<configDir>/shares/<code>.json` 文件 per share

仿 sessions/ 持久化模式。文件含：

```json
{
  "code": "...",
  "sessionId": "...",
  "createdBy": "<userId>",
  "createdAt": <ms>,
  "expiresAt": <ms | null>,
  "snapshotPath": "<rendered.html path>"
}
```

snapshot HTML 一次性渲染落盘到 `<configDir>/shares/<code>.html`，
view 时直接 readFile + 返 HTML（无 runtime 渲染，免 race / quota
side-effect）。

**理由**：share content 一旦颁码 frozen（cc jsonl 后续 append 不影响
share view）。一次性 render + 落盘 = 最简 immutable 模型，配 long-
cache headers 自然 work。

### D6. Sweeper = lazy GC on activity

不开 background timer。boot 时 `loadSharesSync()` 扫一次清过期（与
`loadDeadStubsSync` 同模式 per m-session-persistence D5）。POST / GET
路径调用时 check `expiresAt` < now → unlink + 404（fail-soft）。

### D7. Caching headers = 完全可缓存

公开 view URL 返 `Cache-Control: public, max-age=31536000, immutable`
（1y cache + `immutable` 提示 browser/CDN 永不 revalidate）。content
一旦颁码 frozen + UUID URI 唯一不重用 → URI 是完美 cache key。

即使 share 过期被 unlink 或 user delete，已 cache 的 viewer 仍可看
（公开 URL 本就 unbounded fan-out，acceptable trade —— user 应在
share dialog warning 明确"分享不可撤回"）。同 URL 任何时刻同一 byte，
CDN 友好。

### D8. 渲染依赖 = `marked` + 内置高亮

markdown→HTML：`marked` (轻量 ~30KB，已被 Node ecosystem 广泛验证)。
代码高亮：内置简单 lexer（仅识 fence ` ``` ` + language hint，inline
style 涂色 5-6 关键字 / string / comment / number 即可）—— 避免 引入
shiki/highlight.js (~500KB) 让 share view bundle 膨胀。

**不做**：shiki / highlight.js / prismjs（过度依赖，v2+ 视需要加）。

### D9. 前端 share-create dialog

session 列表 row 上下文菜单加 "分享" 入口（或 terminal-header
overflow menu）。用 `DialogBase` (m-design-system-unify) 写
`ShareCreateDialog`：

- 内容：scope = "整个 session"（v1 唯一选项）+ TTL select (1d / 7d /
  30d / never) + 提交按钮
- 提交成功 → 显示 short URL + 复制按钮（`navigator.clipboard
  .writeText`）
- 错误 toast

### D10. /settings 加 "我的分享" section

`ToolbarConfigSection` 之后加 `MySharesSection`：列自己创建的 shares
（code / sessionId 关联的 project name / expiresAt / 删除按钮）。
DELETE `/api/share/<code>` → unlink + 204。

### D11. share view 公开 page

新 route `/share/:code`（**不**走 RequireLogin guard）。渲染:

- header: `<project name>` + "由 <username> 分享 · <createdAt>"
- 主体: rendered HTML（messages turn-by-turn）
- footer: "ccanywhere" 小字（不带链接，避免 unauth 路径泄漏）
- 主题切换：复用 ccanywhere effective theme（保持 dark/light），但
  share view localStorage scope 独立（不污染 main app 设置）
- 不渲染 sidebar / drawer / toolbar — share view 是纯 viewer

## 落地点

**新增**:

- `src/share/render.ts`：jsonl→HTML programmatic renderer + 简单
  syntax highlight lexer + theme tokens (light/dark CSS variables)
- `src/share/store.ts`：`ShareStore` 类 (`save / load / delete /
  loadAllSync / sweepExpired`)
- `src/share/code.ts`：base62 share code 生成
- `src/server/routes/share.ts`：`POST /api/share`、`GET
  /api/share/list`、`DELETE /api/share/:code`、`GET /share/:code`
- `src/share/render.test.ts` / `store.test.ts` / 路由 test
- `web/src/pages/share-view.tsx`：公开 view 页面（renderer 返 HTML，
  浏览器直接显示）—— 实际可能不需要 React page 因 server 直接返完整
  HTML（含 inline CSS + 主题切换 JS）
- `web/src/components/share-create-dialog.tsx`
- `web/src/components/my-shares-section.tsx`（/settings 内）
- `openspec/specs/share/spec.md`（新建 area）

**改写**:

- `src/config/schema.ts`：加 `shareTtlMs?: number` optional
- `src/cli/serve.ts`：构造 ShareStore + 传给 routes; `loadSharesSync()`
  扫过期
- `src/server/server.ts`：wire share routes（注意 `/share/:code` 是
  无鉴权 path）
- `web/src/pages/session-list.tsx` 或 row context menu：加 "分享" 入口
- `web/src/pages/settings.tsx`：加 MySharesSection
- `web/src/app.tsx`：加 `/share/:code` 公开 route（绕过 RequireLogin）
- `openspec/specs/rest-api/spec.md`：加 share endpoints Requirement
- `web/src/state/sessions.ts` 或新 `state/shares.ts`：share list +
  create + delete actions

## 形式化保证

- F1. share view 路径 (`/share/<code>` + `/api/share/list` 的 GET 仅
  自己创建) MUST 与 user/token cookie 完全解耦。`GET /share/<code>`
  MUST 不读 cookie、不校验 session、不触发 quota。
- F2. share content 一旦颁码 frozen：snapshot HTML 写盘后 cc jsonl
  后续 append MUST NOT 影响 view 内容。
- F3. share view MUST NOT 暴露 sessionId / userId / token / device 等
  鉴权层 identifier（snapshot HTML 只含 project name + username +
  messages + createdAt）。
- F4. expired share GET → 404 **from origin**（即使 `<code>.json` 尚
  未被 sweeper unlink，路由层 check `expiresAt < now`）。注：D7
  immutable cache 让 已 cache 的 viewer 仍能看 —— 这是公开 URL fan-
  out 不可撤回的 known property，dialog 中明确告知 user。
- F5. cross-user share create MUST 404（不泄漏存在性，与
  `/api/sessions` cross-user 一致）。

## 不做

- xterm visual replay（v0 砍掉路径）
- 自定义模板 / 主题（v1 仅默认 light/dark）
- 评论 / 互动
- password-protected share（v2+）
- watermark / branding
- turn-by-turn select（v1 整 session 全 share；v2 可加 range）
- shiki / highlight.js / prismjs 重量依赖
- runtime re-render（snapshot HTML 写盘后 frozen）

## 范围估算

| 模块 | LOC |
|---|---|
| share/render.ts（含简单 syntax highlight） | ~180 |
| share/store.ts | ~80 |
| share/code.ts | ~20 |
| share routes + tests | ~150 |
| share store / render tests | ~80 |
| serve.ts 接线 + schema | ~25 |
| share-create-dialog | ~70 |
| my-shares-section | ~80 |
| share-view 路由 / 公开 route 接线 | ~30 |
| sessions row context menu "分享" 入口 | ~15 |
| spec delta（share/spec.md 新 + rest-api 加段） | ~100 |
| **总** | **~830 LOC** |

实际超 m-share-static-export stub 估算（~600）—— stub 未含 test +
spec delta。

## Commit 边界

| # | scope | 验证 |
|---|---|---|
| C1 | `src/share/{render,store,code}.ts` + tests | typecheck / unit test / lint |
| C2 | routes (`POST/GET/DELETE /api/share*` + `GET /share/:code` + tests) + serve.ts 接线 + schema | typecheck / route test / lint / build:all / kickstart healthz 200 |
| C3 | share-create-dialog + sessions row context menu "分享" 入口 | e2e visual screenshot 自检 |
| C4 | my-shares-section in /settings + share-list / delete UI | e2e visual screenshot |
| C5 | share-view 公开 route (`/share/:code` 绕 RequireLogin) + caching headers + sweeper boot 接线 + e2e | mobile + desktop e2e |
| C6 | spec delta（share/spec.md 新 + rest-api 加段）+ archive + BACKLOG | lint:md |

## 关联

- 上下文：`openspec/archive/2026-05-11-m-multi-user/proposal.md` §Share
- 依赖：m-multi-user (✓ ship)、m-session-persistence (✓ ship)、
  m-design-system-unify (✓ ship - 复用 DialogBase / settings page)
- 不影响：cc 进程 / quota 路径（share 完全 read-only on jsonl）
- 触发 BACKLOG：B13 (dead session retention policy) 可能与 share
  lifetime 互动 — 但 v1 不涉及 dead session share，B13 仍 deferred

## 反向风险评估

- **公开 URL 泄漏 sessionId**：jsonl 内可能含敏感命令 / 路径 / secret。
  share 是 user opt-in，user 应 review session 内容前 share。spec 加
  warning in share-create-dialog "确认会话内容不含 secret 后再分享"。
- **storage 累积**：snapshot HTML 落盘每条 ~10-100KB；长 ttl + 高频
  share → 磁盘膨胀。lazy sweeper 仅 boot 时清。v2 可加 size cap。
- **永久 share never expire** 选项：user 故意永久公开，但 user 主动
  delete 仍可。
- **未登录 fan-out**：公开 URL 一旦传出去不可撤回 cache（per D7
  immutable）。user 应 informed consent in dialog。
