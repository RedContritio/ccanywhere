# Tasks: m-pricing-staleness-sentinel (planned)

## Phase 1 — 实现 + test

- [x] T1.1. `src/quota/pricing.ts` 加 `LAST_VERIFIED` 常量 +
  `maybePricingStaleWarn(now?, warn?)` helper
- [x] T1.2. `src/quota/pricing.test.ts` 加 stale warn 3 case：阈值前 /
  阈值刚到 / 阈值后
- [x] T1.3. `src/cli/serve.ts` startup 调一次 `maybePricingStaleWarn()`
- [x] T1.4. typecheck:all / lint / lint:md / test 全过

## Phase 2 — Ship

- [x] T2.1. build:all + kickstart + healthz 200
- [x] T2.2. commit `feat(server): m-pricing-staleness-sentinel —
  LAST_VERIFIED + boot warn (B7)`
- [x] T2.3. archive `mv changes/m-pricing-staleness-sentinel
  archive/<date>-m-pricing-staleness-sentinel` + 回填 hash
- [x] T2.4. BACKLOG.md 删 B7

## Commits

- (no matching commits found in git log)
