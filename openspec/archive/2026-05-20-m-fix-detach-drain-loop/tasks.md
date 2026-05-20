# Tasks: m-fix-detach-drain-loop

## C1. detach loop drain + regression test

- [ ] T1.1 `src/session/manager.ts:271-273` — `detach()` 单 snapshot 改
      `while (this.pendingWrites.size > 0)` loop
- [ ] T1.2 `src/session/manager.detach-drain.test.ts` — 新文件,
      white-box test:trackWrite 一个 early promise,在其 settle 时通过
      trackWrite 加 late promise;调 detach,verify late promise 也完成
- [ ] T1.3 `pnpm test --run src/session/manager.detach-drain.test.ts` 全过
- [ ] T1.4 commit C1 — `<hash>`

## C2. 验证 30x 整套跑 + archive

- [ ] T2.1 `for i in $(seq 30); do pnpm test 2>&1 | grep -c "manager.persistence.*FAIL\|FAIL.*manager.persistence"; done`
      — 30 次整套跑,manager.persistence 0 fail
- [ ] T2.2 `mv openspec/changes/m-fix-detach-drain-loop
      openspec/archive/2026-05-20-m-fix-detach-drain-loop`
- [ ] T2.3 commit C2 archive + hash 回填
