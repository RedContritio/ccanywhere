# Tasks: M-multi-user-integration-tests

## 1. fixture 改造（前置）

- [ ] `src/server/server.test-helpers.ts`：
  - 加 guestProjectsRoot tmpdir
  - 构造 UserStore（statePath / guestProjectsRoot）→ 取 owner
  - 构造 TokenStore（statePath）
  - DeviceStore ownerId 改用 `owner.id`（替代 `'test-owner-id'`）
  - cleanup 加 guestProjectsRoot rmSync
  - 加 `createLimitedUserWithToken(username, opts?)` helper
  - 暴露 `userStore` / `tokenStore` / `owner` / `guestProjectsRoot`

## 2. server.auth-token.test.ts（新文件）

- [ ] POST /api/auth/token 成功 → 200 + Set-Cookie 含 token plaintext +
  body `{ ok, user: { username, kind: 'limited' } }`
- [ ] POST /api/auth/token wrong token → 401
- [ ] POST /api/auth/token revoked token → 401
- [ ] POST /api/auth/token body validation 失败（短 token < 32）→ 400
- [ ] GET /api/me/quota with limited cookie → 200 + limited quota object
- [ ] GET /api/me/quota with owner cookie → 200 + null limits
- [ ] GET /api/me/quota 无 cookie → 401

## 3. server.multi-user.test.ts（新文件）

- [ ] POST /api/sessions as limited user, cwd 在 owner.projectsRoot 子树（demo）
  → 403 forbidden
- [ ] POST /api/sessions as limited user, cwd 在自己 guest root 下（先创建
  project at `<guestProjectsRoot>/<username>/demo`）→ 201 created
- [ ] GET /api/sessions filter：owner 创建 session_o，alice 创建 session_a
  → owner GET 只见 session_o；alice GET 只见 session_a
- [ ] DELETE /api/sessions/:id cross-user（owner 删 alice 的）→ 404
- [ ] DELETE /api/sessions/:id 自己的 → 204

## 4. ws/server.test.ts 加 cross-user case

- [ ] owner 创建 session，用 alice token cookie WS upgrade 同 session id
  → close code 1008（与 not-found mask 一致）

## 5. 验证

- [ ] pnpm typecheck:all → exit 0
- [ ] pnpm lint → exit 0（含 max-lines 检查；新 test 文件 ≤ 500 LOC）
- [ ] pnpm lint:md → exit 0
- [ ] pnpm test → 全 pass，新增 case 数 ≥ 12
- [ ] 现有 server.test.ts 16 个 test 保持 pass（fixture 改造无破坏性）

## 6. 归档

- [ ] commit 后归档 `openspec/changes/m-multi-user-integration-tests/` →
  `openspec/archive/2026-05-11-m-multi-user-integration-tests/`
