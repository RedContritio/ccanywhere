# Proposal: m-limited-user-web-login — limited user 通过 web 登录

## Intent

m-multi-user (#44 `8349fa7`) ship 后真 bug：limited user 拿到 plaintext
token 但**没法通过 web 登录**。

两个 root cause：

1. `/api/auth/me` 仅识别 `req.authDevice`（owner-only），limited 走 token
   cookie 无 device → 401
2. `/login` 页只有 WebAuthn 流程（`navigator.credentials.get`），没 token
   输入 UI

m-multi-user 后端 token 路径完整（POST /api/auth/token + hookEarlyAuth
双 try），但 web 前端没暴露入口。e2e backbone (#32 `f818c45`) 撞到这
gap，e2e 暂走 API-only smoke。本笔补完整闭环。

## 决策

- **/api/auth/me 改返统一形状** `{ id, label, kind, lastUsedAt }`：
  - owner: device 字段 + kind='owner'
  - limited: user 字段 + kind='limited'
  - 401 仅当双途都不命中
- **useAuthStore 加 `kind: 'owner' | 'limited' | null`** —— 持久化；
  `setLimitedSession(userId, username)` 新 action
- **/login 加 token 输入 mode** —— 切换按钮"用 token 登录（受限用户）"，
  64 hex token + 提交 → POST /api/auth/token → set cookie → probeSession
  → setLimitedSession → /workspace
- **保留 owner WebAuthn 入口为默认** —— desktop / 已配对设备主流量

## 落地

后端：
- `src/server/routes/auth.ts` `/api/auth/me` 兼容 limited
- 测试 +3 cases on `server.auth-token.test.ts`

前端：
- `web/src/auth-flow.ts` probeSession 返 kind / runTokenLogin 新增
- `web/src/state/auth.ts` AuthSnapshot 加 kind / setLimitedSession action
- `web/src/pages/login.tsx` Mode union 加 'token-input' + 'token-submitting' /
  UI 加 token 表单 / probeSession 路径分支 owner vs limited
- 测试 +1 case on `state/auth.test.ts` (setLimitedSession)

E2E：
- smoke.spec.ts 恢复 UI flow test "storageState lands limited user on
  /workspace (no /login bounce)"

spec delta:
- `openspec/specs/auth/spec.md` "用户与令牌" Requirement 段加 `/api/auth/me`
  统一形状契约

ship: `bd67244 feat(web): limited user web 登录 — /api/auth/me 兼容 + token 输入 UI`

## 形式化保证

| 性质 | 机制 |
|---|---|
| limited 能通过 web 登录 | /login 加 token 入口 + probeSession 识别 limited |
| owner 体验不变 | WebAuthn 路径默认；token 入口在 idle-no-device 分支才显示 |
| RequireAuth 不抢戏 | useAuthStore.deviceId 字段 reuse（limited 走 setLimitedSession 时塞 userId）|
| 跨设备 token 复用 | server 端 token 不绑设备；cookie value = token plaintext + ttl ≤ token.expiresAt |

## 历史教训

- e2e backbone ship 时撞到这 bug，被迫退到 API-only smoke；ship 后补 UI
  flow 测试 — **新功能 spec 完整闭环（前端入口 + 后端契约 + e2e）应该一笔，
  而不是 m-multi-user ship 前端 UI 漏掉两周后补**
- 教训写到 m-multi-user-integration-tests archive 也合理
