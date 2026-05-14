# Tasks: m-logout-preserve-pairing

## 准备 / 设计对齐

- [ ] D1-D3 决策点对齐（见 proposal）。默认推荐：D1 保留 label / D2
      clearSession / D3 不加 telemetry。需用户最终拍板。

## 实现

- [ ] `web/src/state/auth.ts`：移除 `logout`，新增 `clearSession()` +
      `unpair()`。
- [ ] `web/src/state/auth.test.ts`：覆盖 `clearSession` 保留 deviceId /
      label / kind，仅清 verifiedAt；`unpair` 全清。
- [ ] `web/src/pages/workspace.tsx`：onLogout 改调 `clearSession`（保留
      `logoutServer` 调用顺序）。
- [ ] `web/src/pages/login.tsx`：
      - 「重新配对其他设备」link 改调 `unpair()` + 先 `await
        logoutServer()`（保证 server cookie 也清，否则同一会话残留）。
      - `runLogin` 失败分支改调 `unpair()`（webauthn credential 已 revoke
        必须重 pair）。
      - limited 用户 `kind === 'limited'`：进 login 页时仍 suggestLogin=
        false（走 token 流），即便 deviceId 非 null。
- [ ] `web/src/api.ts`：401 拦截改调 `clearSession()`。

## 测试

- [ ] `web/src/state/auth.test.ts` 单测见上。
- [ ] `web/src/pages/login.test.tsx`（若不存在则新建）：deviceId 已存的
      场景显示「用本机生物识别登入」+「重新配对其他设备」link；点 link 走
      unpair → 设备名输入框出现。
- [ ] e2e（`e2e/`）：pair → workspace → 点登出 → 回 login 页 → 断言显示
      「用本机生物识别登入」按钮（不是设备名输入框）。

## Spec delta

- [ ] `openspec/specs/auth/spec.md`（若不存在新建）：加 Requirement
      "登出保留配对身份"  + Scenario "已配对设备登出后直接复登 / 显式解
      除配对后回到全新流程"。

## Ship

- [ ] 部署验证：pnpm typecheck:all && lint && test && build:all →
      launchctl kickstart → curl /healthz 200。
- [ ] commit（含 archive 路径 + spec delta 摘要）。
- [ ] 归档：`mv openspec/changes/m-logout-preserve-pairing
      openspec/archive/<date>-m-logout-preserve-pairing`。
