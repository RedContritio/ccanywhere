---
status: shipped
---

# Proposal: m-logout-preserve-pairing — 登出保留配对身份 + 双轨多 token

## 状态

**shipped 2026-05-15。** 原始 brainstorm（单 token / 保 deviceId）保留下方
作为 audit 轨迹；实际 ship 期间 user feedback 把 scope 扩展为：

1. **双轨独立缓存** — owner stored slot + limitedUsers[] list 互不清除，
   同设备可同时记住"已配对 owner"和"曾用 alice/bob 等 limited user 登过"
2. **多 user 多 token** — `limitedUsers[i].tokens[]`，dedup-by-plaintext
   upsert；按 `expiresAt` 降序自动顺序尝试
3. **指数退让** — `runTokenLogin` 返 `TokenLoginResult` discriminated
   (`ok / invalid / transient`)，transient 退让 4 次 (500ms / 1s / 2s /
   4s) **永不**误删合法 token
4. **保留 user record** — 所有 token 都 invalid 后**保留 user record**
   (tokens 空) 让设备记住"曾以此 user 登录过"，提示输入新 token
5. **RequireAuth 自动跳页** — `clearSession` 清 active session →
   RequireAuth 软导航到 /login，删 api.ts 的 `window.location.href` 硬跳

最终 spec 见 `openspec/specs/auth/spec.md` 内 `Requirement: 登出保留配对
身份`。

## 状态（原 brainstorm）

planned。源自用户反馈：同一台设备点"登出"后，下次回 login 页又要重新输设备
名重新走 register → mac approve 全流程。期望"登出"仅清 server cookie + 本地
"已验证"标记，**保留**配对身份（deviceId + label），下次点一次"用本机生物识
别登入"即可恢复。

## Intent

把"登出"和"解除配对"在前端语义上拆开：

- **登出（logout）** = 销毁 server session cookie + 清 `verifiedAt`，**保留**
  `deviceId / label / kind`。回到 login 页 `suggestLogin=true`，一键
  webauthn 即可重新拿 cookie。
- **解除配对（unpair）** = 当前 `logout()` 全清行为，把 localStorage
  `ccanywhere.auth` 抹掉。仅由用户**显式**点 "重新配对其他设备" 触发，或
  server 401 fallback（凭证已 revoke）触发。

## 现状（行为已确认，见 grep）

- `web/src/state/auth.ts:50` `logout: () => set({ ...initial })` 全清。
- `web/src/pages/workspace.tsx:141` 「登出」按钮调 `logoutServer()`（清
  cookie）+ `logout()`（清 localStorage）。
- `web/src/pages/login.tsx:183` 「重新配对其他设备」按钮调 `logout()`。
- `web/src/pages/login.tsx:104` `runLogin` 失败时调 `logout()` fallback。
- `web/src/api.ts:53` 任何 401 都调 `logout()` 全清。

后果：用户每次"登出"都退化到全新设备状态，必须重新走 pair 流程（输设备名 →
webauthn register → mac CLI approve），即便这就是同一台设备。

## 配套逻辑（推导）

1. **新增 store API**：
   - `clearSession()`：仅 `set({ verifiedAt: null })`（**保留** deviceId /
     label / kind）。
   - `unpair()`：原 `logout()` 行为，全清回 `initial`。
   - 原 `logout` API 移除（避免歧义 + 调用点强制选边）。
2. **调用点 rewire**：
   - workspace「登出」按钮：`logoutServer()` + `clearSession()`。
   - login「重新配对其他设备」按钮：`unpair()`（显式换设备）。
   - `runLogin` 401 fallback：`unpair()`（凭证已失效，必须重 pair）。
   - `api.ts` 401 拦截：`clearSession()`（保留 deviceId 让用户一键复登，**不**
     强制重 pair。仅当下一次 webauthn 也 401 才升级到 unpair）。
3. **login 页路径**：进 login 时若 `deviceId !== null` → `suggestLogin=true`
   显示「用本机生物识别登入」+「重新配对其他设备」（小字 link）。当前已是此
   逻辑（`login.tsx:55,150,168`），新行为天然兼容。
4. **limited 用户（token 登录）**：limited 没有 webauthn 凭证，登出后保留
   `label`（username）但 token 必须重输——`clearSession()` 不变，limited
   下次进 login 页**没有**生物识别按钮，必须重新点「用 token 登录」。这点要
   在 login.tsx 加判断：`kind === 'limited'` 时即便 `deviceId !== null` 也
   走 token-input 流（或保持 idle + suggest token？决策点）。

## 形式化保证

- **配对身份单调性**：localStorage `ccanywhere.auth` 的 `deviceId` 一旦被设
  置，只能由 `unpair()` 清除——`clearSession()` 永远不动它。
- **server / client 状态一致**：调用 `unpair()` 必伴随 `logoutServer()` 把
  cookie 也 revoke（防止 cookie 残留但前端无 deviceId 的"幽灵会话"）。当前
  workspace.tsx 已遵循；login 页「重新配对」link 需补 `logoutServer()`
  调用。
- **凭证失效降级**：webauthn 凭证被 mac CLI revoke 后，server 401 必须能让
  前端从 `clearSession()`-后状态 → `unpair()` 状态。靠 `runLogin` 失败分支
  做这件事。

## 决策点（启动前定）

- **D1**. limited 用户登出后是否保留 `label`（username 回显）？保留更便利
  但 username 不是凭证，没强需求。倾向保留。
- **D2**. `api.ts` 401 拦截到底用 `clearSession` 还是 `unpair`？激进派
  `unpair`（401 = 状态全坏，重 pair 安全）；保守派 `clearSession`（cookie
  过期是常态，没必要让用户重 pair）。倾向**保守 `clearSession`**——cookie
  TTL 比 webauthn credential 短得多，401 远比 credential revoke 常见。
- **D3**. 是否给 `clearSession` 加 telemetry 区分两种 logout（自愿 vs
  fallback）？暂不做，无 observability 需求。

## 范围（估）

~50-80 LOC + 测试 ~30 LOC：

- `web/src/state/auth.ts` — split logout → `clearSession` / `unpair`（~15
  LOC）+ test update（auth.test.ts ~10 LOC）
- `web/src/pages/workspace.tsx:146-147` — 改调 `clearSession`（~2 LOC）
- `web/src/pages/login.tsx:104,183` — `runLogin` fallback 走 `unpair`；「重
  新配对」按钮走 `unpair` + `logoutServer()`（~5 LOC）
- `web/src/api.ts:53` — 改 `clearSession`（~2 LOC）
- e2e 加 case：login → workspace → logout → 回 login 页应显示「用本机生物
  识别登入」按钮（不是设备名输入框）（~15-25 LOC）

## 不做

- mac CLI `revoke` 后服务端推送给前端实时降级：当前 401 fallback 已足够，
  不上 WS push。
- 多设备配对管理 UI（"我配对过哪些设备"列表）：归属 m-multi-user 的延伸，
  本次不涉及。
- 自动续期 server cookie 让 401 永不触发：cookie TTL 是有意短，不动。

## 关联

- 出处：用户 2026-05-14 反馈"同设备登出后不该销毁凭证"
- 依赖：无（独立改动，不依赖其他 in-flight change）
- 触及面：auth store + login 页 + workspace 页 + api.ts 全局 401 拦截
