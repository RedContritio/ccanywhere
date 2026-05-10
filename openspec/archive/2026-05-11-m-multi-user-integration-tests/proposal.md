# Proposal: M-multi-user-integration-tests — 高层 integration 测试覆盖

## Intent

#44 m-multi-user (v12.1) ship 仅含 chunk 1 store 单测（25 个：UserStore /
TokenStore），**未覆盖**整条 HTTP / WS 链路上的 user 隔离与 token 鉴权
新路径。本 change 补齐 fastify-inject 级别的 integration test，证明
spec 中 "用户隔离" / "用户与令牌" 两个 Requirement 在真实路由组合下成立。

不改动产品代码（除非 fixture 暴露的 hook 不足而要补 `__forTest` 方法）。

## 已 ship 但无 e2e 覆盖的路径

1. **POST /api/auth/token** — token 校验、cookie 设置、返回 user 信息
2. **GET /api/me/quota** — owner null limits / limited 返回 quota
3. **POST /api/sessions cwd 子树校验** — limited 用户用 owner projectsRoot
   下的 demo project → 403（cwd 不在 `<guestProjectsRoot>/<username>/`）
4. **GET /api/sessions filter** — alice 看不到 owner / 反之
5. **DELETE /api/sessions cross-user** — 返回 404（mask 为 not-found，
   避免泄露归属）
6. **WS upgrade cross-user** — close code 1008

仅 store 单测在 unit 层验过；上面 6 条都需要 fastify 路由 + auth hook +
hookEarlyAuth 双路径协同。

## 范围

### 必须

- 改造 `server.test-helpers.ts` fixture：
  - 始终构造 UserStore + TokenStore（guestProjectsRoot 也用 tmpdir）
  - 暴露 `userStore` / `tokenStore` / `owner` / `guestProjectsRoot` /
    `createLimitedUserWithToken` helper
  - DeviceStore.ownerId 改用 `userStore.getOwner().id`（real uuid），
    替代硬编码 `'test-owner-id'`
  - 现有 16 个 server.test.ts 不传 buildServer userStore → 行为不变
- 新文件 `src/server/server.auth-token.test.ts`：覆盖路径 (1) (2)
- 新文件 `src/server/server.multi-user.test.ts`：覆盖路径 (3) (4) (5)
- `src/ws/server.test.ts` 加 1 个 test case：覆盖路径 (6)

### 不做

- 不写 quota 实时累加测试（这需要 cc 子进程 / UserPromptSubmit hook 链路；
  v12.1 quota hook 尚未实施，是单独 task）
- 不改产品代码契约（fixture 若需要 hook 暴露则单独评估）
- 不删 chunk 1 store 单测（互补关系）

## fixture 改造关键点

```ts
export function setupProjects(): TestProjectsEnv {
  const projectsRoot = mkdtempSync(...);
  const guestProjectsRoot = mkdtempSync(...);
  const userStore = new UserStore({ statePath: ..., guestProjectsRoot });
  const owner = userStore.getOwner();
  const tokenStore = new TokenStore({ statePath: ... });
  const deviceStore = new DeviceStore({ statePath: ..., ownerId: owner.id });
  // 现 device.userId = owner.id（real uuid），multi-user wired 时 hookEarlyAuth
  // 反查 owner 能查到，旧测试不查 userStore 也无影响
  ...
  return {
    ..., userStore, tokenStore, owner, guestProjectsRoot,
    createLimitedUserWithToken: (username, { costLimitUsd, ttlMs }) => {
      const user = userStore.createLimitedUser({ username, costLimitUsd, tokensLimit: null });
      const { plaintext } = tokenStore.issue({ userId: user.id, ttlMs });
      return { user, plaintext, authCookie: `ccanywhere_session=${plaintext}` };
    },
  };
}
```

新测试调用 `buildServer({ ..., userStore: env.userStore, tokenStore: env.tokenStore })`
显式启用 multi-user 路径。`config.projectsRoot` 用 `env.projectsRoot` 真路径覆盖
baseConfig 的占位（cwd guard 用 config.projectsRoot 做 owner 根）。

## 形式化保证（test 完成后）

| 性质 | 保证机制 |
|---|---|
| limited 不能访问 owner cwd | server.multi-user.test.ts "cwd 不在子树 403" |
| owner 看不到 limited 的 session（反之亦然）| server.multi-user.test.ts "GET filter" |
| cross-user DELETE / WS 不泄露归属 | "DELETE 返 404" + "WS close 1008" |
| token cookie 颁发 + 过后续请求 | server.auth-token.test.ts "token login + /api/me/quota" |
| owner 走 device path 不被 multi-user wire 破坏 | server.test.ts 16 个旧 test 保持 pass |

## 关联

- 不动 OpenSpec spec（test 不改契约）→ 无 specs/ delta
- 与 m-fit-cols-dpr (cd8408b) 并行，互不依赖
- 中优先 spec rest-api delta 留另一个 change（POST /api/auth/token / GET /api/me/quota
  接口契约）
