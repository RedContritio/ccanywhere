# Tasks: m-webauthn-routes-test

## 决策对齐

- [ ] mock 粒度：仅 verifyRegistration / verifyAuthentication（保持
      makeRegistrationOptions / makeAuthenticationOptions 真跑）
- [ ] 测试 fixture 复用 server.test-helpers.ts 的 setupProjects +
      buildServer

## 实现

- [ ] `src/server/server.auth-webauthn.test.ts`：
  - vitest mock `../devices/credential.ts` 模块，局部替换 verify*
  - beforeEach 构建 app（含 userStore + deviceStore，不依赖 tokenStore）

## Case 覆盖

- [ ] register-init body 合法 → 201 + pendingId + pending 写入 store
- [ ] register-init body 缺 label → 400
- [ ] register-complete pendingId 不存在 → 404
- [ ] register-complete pending 已 approved → 409 invalid_state
- [ ] register-complete verify 抛 CredentialError → 400
      verification_failed
- [ ] register-complete verify 通过 (mocked) → 200 + pending status
      转 awaiting-approval + pendingCredentials 含 credential
- [ ] register-status pending = awaiting-approval → 200 + 不 setCookie
- [ ] register-status pending = approved + issuedSessionId 非空 →
      200 + Set-Cookie + deviceId
- [ ] login-init device 不存在 → 404
- [ ] login-init device.status = revoked → 404
- [ ] login-init device 的 user.kind = limited → 403 forbidden
- [ ] login-init owner device → 200 + tempId + options
- [ ] login-complete tempId 不存在 → 400
- [ ] login-complete device 已 revoke → 404
- [ ] login-complete verify 抛 CredentialError → 401
- [ ] login-complete verify 通过 (mocked) → 200 + bumpDeviceCounter +
      Set-Cookie + issueSession
- [ ] logout 含 cookie → 204 + clearCookie + revokeSession
- [ ] logout 无 cookie → 204（不抛错）

## Spec delta

- [ ] 无 — 测试新增，外部契约已在 `openspec/specs/auth/spec.md`

## Ship

- [ ] typecheck:all + lint + test pass
- [ ] commit hash:
