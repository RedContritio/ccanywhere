# Proposal: m-e2e-backbone — playwright e2e against prod URL via globalSetup token

## Intent

承接 m-multi-user (#44) 解锁的 token-based limited user 登录路径。
playwright e2e 直接打 prod 域名 `https://cc.example.com`（走真 frpc /
HTTPS 链路），用 globalSetup 通过本地 internal RPC 颁固定 'e2e'
limited user + token，写 storageState cookie，浏览器 context 天然隔离
不串你真浏览器 cookie。

m-multi-user archive tasks.md 列了 "#32 e2e backbone v12.1 (~40 LOC)"
作为推进顺序 step 4，但当时未单独 archive。本笔补归档 + 加 spec delta。

## 决策

| # | 决策 | 拍 |
|---|---|---|
| C1 测试目标 | prod 实例 + prod 域名 | 不起 staging，避免单独 cert/port/cookieName drift |
| C2 token 颁发 | globalSetup 调本地 internal RPC (cliToken) 颁 token | LaunchAgent already running，loopback 链最短 |
| C3 user kind | limited (固定 username 'e2e' 复用) | 不污染 owner data；token 每次 rotate |
| C4 smoke 范围 | API-only smoke + 1 个 UI flow（limited login 后续补） | 不依赖 webauthn (e2e 无生物识别) |
| C5 CI 集成 | 仅本地手动 | 留独立 task；prod URL 公开后 GitHub Actions 可加 |
| C6 cleanup | globalTeardown DELETE token；user 保留复用 | 避免每次创新 user 累积 fs |

## 落地

- `web/playwright.config.ts` baseURL=https://cc.example.com + globalSetup +
  globalTeardown + storageState
- `web/e2e/global-setup.ts` (206 LOC): 读 cli-token + GET/POST internal
  users + 写 .auth/storageState.json + teardown.json
- `web/e2e/global-teardown.ts` (42 LOC): DELETE token + clean .auth/
- `web/e2e/smoke.spec.ts` (81 LOC): 6 cases
  - healthz public 200
  - /api/me/quota kind=limited
  - /api/projects list
  - POST /api/sessions 403 (cwd guard, owner project + limited user)
  - cookieless → 401
  - storageState lands limited user on /workspace (后来 limited-user-web-login
    ship 后才能 pass)
- `.gitignore` 加 `.auth/`

ship: `f818c45 feat(e2e): #32 e2e backbone — prod URL + token cookie via globalSetup`

## 形式化保证

| 性质 | 机制 |
|---|---|
| 真实 prod 链路覆盖 | baseURL = https 域名 + frpc + acme cert + Secure cookie + SameSite=Lax |
| user 浏览器 session 不被串扰 | playwright BrowserContext 默认隔离；cliToken 颁的是 limited user，不是 owner |
| e2e user fs 不累积 | username 固定 'e2e'，复用同 fs dir；token rotate |
| token 不残留 | globalTeardown DELETE 即颁即销；user 留着复用 |

## 历史教训

ship 时撞到 limited user 无 web 登录 bug（m-limited-user-web-login 即此
follow-up），smoke 退到 API-only。教训：跨 v 大改动后第一笔 e2e 应同步
补 UI flow + 检查所有 user kind 都能完整登录。
