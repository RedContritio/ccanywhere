# Tasks: m-e2e-backbone (shipped 2026-05-12, `f818c45`)

- [x] T1. playwright.config.ts: baseURL prod + globalSetup/Teardown + storageState
- [x] T2. global-setup.ts: cli-token + find/create user + write storageState
- [x] T3. global-teardown.ts: revoke token + clean .auth/
- [x] T4. smoke.spec.ts: 5 API cases (healthz / quota / projects / cwd guard / 401)
- [x] T5. .gitignore 加 .auth/
- [x] T6. 跑通：`pnpm -F ccanywhere-web exec playwright test` 5/5 pass <600ms
- [x] T7. (follow-up `bd67244`) 加第 6 case "storageState lands limited
  user on /workspace" — 依赖 limited-user-web-login ship 后才能 pass
- [x] T8. archive `2026-05-12-m-e2e-backbone/`

## 后续

- CI 集成（GitHub Actions，需要 prod URL public 可达或 self-hosted runner）
- 多 browser project（webkit / firefox）
