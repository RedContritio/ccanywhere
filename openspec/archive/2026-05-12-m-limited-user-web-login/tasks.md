# Tasks: m-limited-user-web-login (shipped 2026-05-12, `bd67244`)

- [x] T1. /api/auth/me 改返 `{ id, label, kind, lastUsedAt }` 兼容 limited
- [x] T2. server.auth-token.test.ts +3 cases (owner / limited / 401)
- [x] T3. probeSession 返回 kind
- [x] T4. runTokenLogin (POST /api/auth/token wrapper) + 401 错误 msg
- [x] T5. useAuthStore 加 `kind` + `setLimitedSession`
- [x] T6. /login 加 token-input mode + UI + probeSession 路径分支
- [x] T7. auth.test.ts +1 case (setLimitedSession)
- [x] T8. e2e smoke 加 UI flow "storageState lands limited user on /workspace"
- [x] T9. spec delta: auth/spec.md "用户级偏好与活跃 session" 段加 me 形状契约
- [x] T10. archive `2026-05-12-m-limited-user-web-login/`
