# Tasks

## 段 1：抽 auth-webauthn.ts

- [ ] T1.1 新建 `src/server/routes/auth-webauthn.ts`：搬 4 zod schema、`pendingCredentials` export、5 路由（register-init / register-complete / register-status / login-init / login-complete）
- [ ] T1.2 定义 `AuthWebauthnRoutesOptions = { store, userStore?, rp, cookieName, cookieOpts }`；export `registerAuthWebauthnRoutes`
- [ ] T1.3 import 路径：`../../devices/credential.js`（CredentialError / make* / verify* / RpInfo）、`../../devices/store.js`（DeviceStore type）、`../../users/store.js`（UserStore type）

## 段 2：抽 auth-session.ts

- [ ] T2.1 新建 `src/server/routes/auth-session.ts`：搬 logout + me 两个路由
- [ ] T2.2 定义 `AuthSessionRoutesOptions = { store, userStore?, cookieName, cookieOpts }`；export `registerAuthSessionRoutes`
- [ ] T2.3 `me` 路由保留 device branch + user branch 两段（`req.authDevice` / `req.user` 仍来自中间件 decorator）

## 段 3：auth.ts 改为 composition

- [ ] T3.1 删 webauthn 路由 body + 4 schema + `pendingCredentials` 定义（已搬走）
- [ ] T3.2 删 logout + me 路由 body（已搬走）
- [ ] T3.3 加 module-private `deriveCookieConfig(opts)` 返回 `{ cookieName, cookieOpts }`；逻辑与原 inline 等价
- [ ] T3.4 `registerAuthRoutes` 改为：派生 rp / cookieConfig → `await registerAuthWebauthnRoutes(...)` → 条件 `await registerAuthMultiUserRoutes(...)` → `await registerAuthSessionRoutes(...)`
- [ ] T3.5 保留 `AuthRoutesOptions` interface + `SESSION_COOKIE_NAME` export（外部 import 入口）

## 段 4：internal.ts import 路径迁移

- [ ] T4.1 `src/server/routes/internal.ts` L4：`from './auth.js'` → `from './auth-webauthn.js'`

## 段 5：Build & Deploy

- [ ] T5.1 `pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm test` 全绿
- [ ] T5.2 `pnpm build:all`
- [ ] T5.3 `launchctl kickstart -k gui/$(id -u)/com.redcontritio.ccanywhere`；`curl -sf http://127.0.0.1:62275/healthz` 返 200
- [ ] T5.4 server.log 检查无 fatal

## 段 6：BACKLOG + Commit + Archive

- [ ] T6.1 `openspec/BACKLOG.md` 删 B14 条目
- [ ] T6.2 commit（含 archive 路径，无 spec delta——结构重构）
- [ ] T6.3 `mv openspec/changes/m-auth-routes-split openspec/archive/<date>-m-auth-routes-split`

## Commits

- 0c9c82e m-auth-routes-split: routes/auth.ts 290 → 90 行拆三段
