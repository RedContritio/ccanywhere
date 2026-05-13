# Tasks: m-build-sha-in-diag

- [x] T1. `web/vite.config.ts` — `execSync('git rev-parse --short HEAD')`
  + ISO timestamp 构造 CC_VERSION；define `__CC_VERSION__`
- [x] T2. `web/src/global.d.ts`（新）— ambient declare
- [x] T3. `web/src/state/diag.ts` — DiagApp.version + collectDiag 读取
- [x] T4. `web/src/state/diag.test.ts` — strict toEqual → toMatchObject
  + 正则守护 version 形态
- [x] T5. pnpm typecheck:all / lint / lint:md / test:all (315 root +
  130 web) ✓
- [x] T6. pnpm build:all + launchctl kickstart + healthz 200 ✓
- [x] T7. e2e visual 7 cases 仍全过 ✓
- [x] T8. subagent 评审 + commit
