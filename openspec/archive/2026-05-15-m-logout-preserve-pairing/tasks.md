# Tasks: m-logout-preserve-pairing (shipped 2026-05-15)

## 实施轨迹

scope 在 ship 期间被 user 反馈连续扩张，从原 proposal 的"保留 deviceId"
演化为"双轨身份 + 多 token + 指数退让"。下方按最终落地清单。

## auth.ts 重塑

- [x] `AuthSnapshot` 拆 active session (`deviceId / label / kind /
      verifiedAt`) vs stored credentials
- [x] owner stored slot: `ownerDeviceId / ownerLabel`（单 slot）
- [x] limited stored slot: `limitedUsers: LimitedUserRecord[]`，每 user
      多 `tokens: { token, expiresAt }[]`
- [x] dedup-by-plaintext upsert (`upsertToken` helper)
- [x] `clearSession`：清 active，保 stored
- [x] `unpair`：全清（测试 / 显式 reset）
- [x] `forgetOwnerCredential`：仅清 owner slot + 若 active owner 则清
      active
- [x] `forgetToken(userId, token)` / `forgetLimitedUser(userId)`
- [x] `DEFAULT_TOKEN_TTL_MS = 7d` const（client-side 估算 expiresAt）
- [x] `partialize` 含所有 stored 字段（localStorage 持久化）

## auth-flow.ts

- [x] `runTokenLogin` 返 `TokenLoginResult` discriminated（`ok` /
      `invalid` / `transient`）
- [x] fetch throw → transient；401 → invalid；非 401 错误 → transient

## api.ts

- [x] 401 拦截调 `clearSession`，删硬跳，依赖 RequireAuth 自动跳 /login

## login.tsx 重写

- [x] idle 状态按 stored 凭证渲染：
      - owner stored → 「用本机生物识别登入」按钮
      - 每个 limitedUser → 一个 button，显示 username + token count
        (count > 1 时)
      - 底部「用新 token 登录」link
      - 无任何 stored → fallback 到 pair 流（设备名输入）
- [x] `tryToken` 指数退让 (500ms / 1s / 2s / 4s)
- [x] `onPickUser` 序列尝试 user 的 tokens (按 expiresAt 降序)
      - invalid → forgetToken，下一个
      - transient → 停，保留全部 token
      - 全 invalid → 保留 user record (tokens 空)，error "请输入新 token"
        + 「输入新 token」primary button 直跳 token-input
- [x] webauthn fail → `forgetOwnerCredential`，保留 limited list
- [x] token-input 页只保留输入框 + 「登录」+ 「返回」link（删了如何获取
      token 的说明）
- [x] 副标题改 Apple 风「在任何屏幕上，继续你的 cc。」
- [x] 抽 `IdleChoices` helper 控制行数

## workspace.tsx

- [x] onLogout 调 `clearSession`（删 `useAuthStore.logout` 引用）

## 测试

- [x] `auth.test.ts` 全部重写：17 个 case 覆盖 active / stored 拆分 /
      多 token upsert / clearSession 保 stored / forgetToken /
      forgetLimitedUser / forgetOwnerCredential / dual-credential 互不
      清除 / persistence
- [x] `api.test.ts` 401 case：active 清空 + stored 保留
- [x] typecheck:all / lint / lint:md / vitest root 416 + web 152

## Spec delta

- [x] `openspec/specs/auth/spec.md` 加 `Requirement: 登出保留配对身份
      （m-logout-preserve-pairing）` + 6 个 Scenario（主动登出保所有
      凭证 / 401 自动跳 / webauthn revoke 仅清 owner / 多 token 顺序
      尝试 / 网络异常不删 / 全 invalid 保 user / 双轨设备）

## Ship

- [x] 必跑序列：typecheck + lint + lint:md + test (root 416 + web 152)
      + build:all + launchctl kickstart + curl /healthz 200
- [x] bundle 验证 `limitedUsers / forgetToken / transient` 等关键字
- [x] commit + archive

## Commits

- 6910669 feat(web): m-logout-preserve-pairing — 双轨身份缓存 + 多 token + 指数退让
- f4c6f21 plan: m-logout-preserve-pairing + m-nav-restructure-globals proposals
