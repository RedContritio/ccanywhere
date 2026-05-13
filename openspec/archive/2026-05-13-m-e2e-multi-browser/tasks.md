# Tasks: m-e2e-multi-browser (planned)

## Phase 1 — 实现

- [x] T1.1. `web/playwright.config.ts` 加 webkit + firefox projects，
  testMatch 限 `smoke.spec.ts`
- [x] T1.2. `.github/workflows/e2e.yml` install 3 browser
- [x] T1.3. typecheck:all / lint / lint:md / test 全过（仅 config 改，
  test 不受影响）

## Phase 2 — Ship

- [x] T2.1. commit `ci: m-e2e-multi-browser — webkit + firefox functional
  smoke (B6)`
- [x] T2.2. archive `mv changes/m-e2e-multi-browser
  archive/<date>-m-e2e-multi-browser` + 回填 hash
- [x] T2.3. BACKLOG.md 删 B6
- [x] T2.4. 注：e2e CI workflow 在下次 push to main 时才会真正跑 3
  browser；本地不必跑 e2e（self-hosted runner 路径）
