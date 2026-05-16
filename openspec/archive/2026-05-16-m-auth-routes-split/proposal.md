---
status: in-flight
---

# Proposal: m-auth-routes-split — routes/auth.ts 拆三段

## Intent

`src/server/routes/auth.ts` 290 行单文件含：

- 5 个 webauthn 路由（register-init/complete/status + login-init/complete）
- 4 个 zod schema
- multi-user mount（已独立到 `auth-multi-user.ts`，本文件仅做 ~7 行 mount）
- 2 个 session-mgmt 路由（logout + me）
- cookie 派生（cookieSecure / cookieName / cookieOpts 构造）
- `pendingCredentials` Map（CLI approve 路由 import 的 side-channel）
- `SESSION_COOKIE_NAME` export（中间件 import）

单段密度合理但跨四个职责，单文件长。BACKLOG B14 deferred ROI 边际，
user 主动启动当成一次 housekeeping。

## Scope

- `auth.ts` 拆出 `auth-webauthn.ts`（5 路由 + 4 schema + `pendingCredentials`）
- `auth.ts` 拆出 `auth-session.ts`（logout + me）
- `auth.ts` 留作 composition：types + cookie helper + 调三段 mount
- multi-user 段已独立，不动
- `internal.ts` 改 import path `./auth.js` → `./auth-webauthn.js`（取
  `pendingCredentials`）
- `src/server/auth.ts`（中间件）import path 不动（`SESSION_COOKIE_NAME` 仍
  从 `routes/auth.js` 取——属于 composition 入口暴露常量）
- `server.ts` import path 不动（`registerAuthRoutes` 仍从 `routes/auth.js`）

## 决策

### D1. 文件结构 flat 不开子目录

候选：
- **A. flat**: `routes/auth.ts` + `routes/auth-webauthn.ts` + `routes/auth-session.ts`
- B. 子目录: `routes/auth/{index,webauthn,session}.ts`

选 A：与现有 `auth-multi-user.ts` 命名一致（`auth-*` prefix），单层目录
扫描成本低，import path 短。子目录 barrel 反而引入"index 是 file 还是
folder"歧义。

### D2. `pendingCredentials` 跟 webauthn 路由放一起

`pendingCredentials` 是 webauthn registration verify 后 → CLI approve 取
attestation result 的 side-channel，语义上属于 webauthn 段。放
`auth-webauthn.ts`；`internal.ts` 的 1 个 import 路径改。

### D3. cookie 派生抽到 auth.ts 内部 helper

`deriveCookieConfig(opts)` 返回 `{ cookieName, cookieOpts }`，被三段
（webauthn login-complete / register-status / session.logout +
multi-user mount）共用。放 `auth.ts` 顶部 module-private 不 export——三段
mount 时传 `cookieName + cookieOpts` 参数即可（webauthn / session /
multi-user signature 已经接受 cookieName / cookieOpts，模式一致）。

### D4. webauthn / session 模块签名

```ts
// auth-webauthn.ts
export interface AuthWebauthnRoutesOptions {
  readonly store: DeviceStore;
  readonly userStore?: UserStore;
  readonly rp: RpInfo;
  readonly cookieName: string;
  readonly cookieOpts: CookieSerializeOptions;
}
export async function registerAuthWebauthnRoutes(
  app: FastifyInstance,
  opts: AuthWebauthnRoutesOptions,
): Promise<void>;

// auth-session.ts
export interface AuthSessionRoutesOptions {
  readonly store: DeviceStore;
  readonly userStore?: UserStore;
  readonly cookieName: string;
  readonly cookieOpts: CookieSerializeOptions;
}
export async function registerAuthSessionRoutes(
  app: FastifyInstance,
  opts: AuthSessionRoutesOptions,
): Promise<void>;
```

`rp` 由 auth.ts composition 派生后传给 webauthn（`deriveRpInfo` 已在
`devices/credential.ts`，逻辑不重复）。

### D5. 不做 backward compat re-export

`internal.ts` 的 1 个 import path 改成新文件名，不在 auth.ts barrel
re-export `pendingCredentials`。`SESSION_COOKIE_NAME` 仍从 auth.ts export
（中间件 import 是 composition 入口语义，留着合理；不是垫片）。

## 落地点

| 文件 | 改动 |
|---|---|
| `src/server/routes/auth-webauthn.ts` (新) | 5 webauthn 路由 + 4 schema + `pendingCredentials` export；接 `AuthWebauthnRoutesOptions` |
| `src/server/routes/auth-session.ts` (新) | logout + me；接 `AuthSessionRoutesOptions` |
| `src/server/routes/auth.ts` | 删 webauthn / session-mgmt 路由 body；保留 `AuthRoutesOptions` + `SESSION_COOKIE_NAME` export；加 `deriveCookieConfig` private helper；`registerAuthRoutes` 改为 composition：派生 rp / cookieConfig → 调三段 `registerAuthWebauthnRoutes` / `registerAuthMultiUserRoutes` / `registerAuthSessionRoutes` |
| `src/server/routes/internal.ts` | `import { pendingCredentials } from './auth.js'` → `'./auth-webauthn.js'` |

测试影响：
- 现有 `routes/auth.ts` 没有专门单测（webauthn 路由测试是 B15
  m-webauthn-routes-test 待办）。本次拆分仅结构变化，外部行为不变；
  现有 `server.ts` integration test（auth route flow）应继续通过，
  作为回归证据。

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 拆分零行为变化 | 路由 handler body 字面搬运；composition 调用顺序 / 参数与原 inline 等价 |
| cookieName / cookieOpts 一致 | `deriveCookieConfig` 单点派生，三段都接收同一对值；与原 inline 派生公式相同（`cookieSecure ?? https?` / `cookieName ?? SESSION_COOKIE_NAME`） |
| multi-user 仍 conditional mount | composition 段 `if (userStore && tokenStore)` 守门不变 |
| `pendingCredentials` lifecycle 不变 | export 位置换文件但是同一 module-level Map；internal.ts import 路径改一处 |
| import path 改最小 | 只 internal.ts 改一行；server.ts / 中间件 import 不变 |

## 不做

- 子目录 `routes/auth/` 结构（D1 否）
- `pendingCredentials` 改成 DeviceStore 字段（属于 store 层重构，本次仅拆 routes）
- webauthn 路由测试（已有 BACKLOG 大项 m-webauthn-routes-test 单独做）
- `SESSION_COOKIE_NAME` 搬到 config schema（独立讨论；目前 routes 自己 own
  fallback 默认值是合理的）
- `deriveCookieConfig` export（仅 auth.ts 自己用；exports 越少越好）
- `auth.ts` 改成 thin barrel 全 re-export（不是垫片需求，留 composition 责任）
