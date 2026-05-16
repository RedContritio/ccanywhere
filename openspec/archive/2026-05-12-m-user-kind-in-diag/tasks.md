# Tasks: m-user-kind-in-diag

- [x] T1. `web/src/state/diag.ts` — import auth store；DiagApp.userKind
  字段；collectDiag 读 store kind 写入 app
- [x] T2. `web/src/state/diag.test.ts` — beforeEach/afterEach 加
  `resetAuthStoreForTest()`；2 个新 case (logged in / logged out)
- [x] T3. pnpm typecheck:all / lint / lint:md ✓
- [x] T4. pnpm test:all (root 315 + web 131+1 skipped) ✓
- [x] T5. pnpm build:all + launchctl kickstart + healthz 200 ✓
- [x] T6. e2e visual 7 cases 仍全过 ✓
- [x] T7. subagent 评审 + commit

## Commits

- (no matching commits found in git log)
