---
status: planned
---

# Proposal: m-webauthn-routes-test — webauthn 路由信封 + 状态机单测

## 状态

planned。`src/server/server.auth-token.test.ts` 全部测 token 路径
(POST /api/auth/token / GET /api/me/quota / preferences / active-session
等 m-multi-user 引入路径)。**没有任何测试覆盖 webauthn 5 个路由**：

- `POST /api/auth/register-init`
- `POST /api/auth/register-complete`
- `GET  /api/auth/register-status`
- `POST /api/auth/login-init`
- `POST /api/auth/login-complete`

webauthn 是 owner 唯一登录入口，挂了 = owner 进不来。M1 ship 至今仅靠
e2e + 手测覆盖；近 ship `m-logout-preserve-pairing` 改 auth 客户端状态
时已有 near-miss 风险。

## 边界（明确不能做的）

webauthn happy path 真签名段不能 unit test ——
`verifyRegistrationResponse` / `verifyAuthenticationResponse` 要真实硬件
签名才返 `verified: true`，构造不出 fake `RegistrationResponseJSON` 让
它过。**此段留给 e2e**。

## Intent

覆盖**信封层 + 状态机层 + verify 通过后行为**，三种测试形式：

1. **不需要任何 mock** — 拒绝路径（body 校验、状态机错位、找不到
   pending / credential、challenge 过期）
2. **vitest 模块 mock `../devices/credential.ts`** — verify 通过后路由
   是否正确做下游动作（写 device、设 cookie、issueSession、bumpCounter）
3. **m-multi-user 边界** — `routes/auth.ts:194-202` "webauthn login only
   for owner" 防御分支

## 形式化保证（测试覆盖契约）

- pair-init MUST 返回 pendingId + 写 pending store (status =
  awaiting-registration) + 不创建 device
- pair-complete pendingId 不存在 → 404
- pair-complete pending.status ≠ awaiting-registration → 409
- pair-complete verify 通过 (mocked) → markPendingAwaitingApproval + 不
  立即创建 device + credential 存进 pendingCredentials side-map
- register-status pending.status = approved → Set-Cookie + 返回 deviceId
- login-init device 不存在 → 404
- login-init device.status = revoked → 404
- login-init device.user.kind = limited → 403
- login-complete tempId 不存在或过期 → 400
- login-complete device 不存在 → 404
- login-complete verify 通过 (mocked) → bumpDeviceCounter + issueSession
  + Set-Cookie + 返回 `{ok:true, deviceId}`
- logout 清 cookie + revokeSession (sessionId 在 cookie 里时)

## 落地点

- 新建 `src/server/server.auth-webauthn.test.ts` (~150 LOC，含 fixture +
  mock 设置 + 上述 case)
- 不动 production 代码

## 范围

~150 LOC 纯新增测试。零 production code 改动。

## 决策点（启动前定）

- mock 粒度：仅 mock `verifyRegistration` / `verifyAuthentication`，让
  `makeRegistrationOptions` / `makeAuthenticationOptions` 真跑（断言它
  们生成的 options 字段）
- 是否 mock @simplewebauthn/server 整模块：不。粒度过粗会失去 options
  生成正确性覆盖

## 不做

- 不测真实密码学 happy path —— 留给 playwright e2e
- 不测 @simplewebauthn/server 自身行为 —— 库自测
- 不引入 software webauthn authenticator (@simplewebauthn/iso-webcrypto)
  —— mock verify 已足够

## 关联

- 出处：本评审 A3 修正版（原 scope 含 happy path，莱可可指出做不到后
  收紧到信封 + 状态机 + mock verify 后行为）
- 依赖：无
