# Tasks: m-resume-args-helper (planned)

## Phase 1 — helper + 单测

- [x] T1.1. `src/session/resume-args.ts`：`getCcSessionId(opts)` +
  `buildResumeArgs(opts)` 两个 export
- [x] T1.2. `src/session/resume-args.test.ts`：5 case 覆盖
  - getCcSessionId resumeSessionId === null → webId
  - getCcSessionId resumeSessionId === undefined → webId
  - getCcSessionId resumeSessionId === 'cc_X' → 'cc_X'
  - buildResumeArgs 输出形状（['--resume', ccSessionId]）
  - buildResumeArgs regression guard：no `--session-id` flag

## Phase 2 — sessions-resume.ts 接入

- [x] T2.1. 改 `src/server/routes/sessions-resume.ts` line 93 + 100
  用 helper
- [x] T2.2. 确认 server.resume-dead-stub.test.ts 全过（route 行为不变）

## Phase 3 — Ship

- [x] T3.1. typecheck:all / lint / lint:md / test 全过
- [x] T3.2. build:all + kickstart + healthz 200（涉及 src/ 必跑）
- [x] T3.3. commit `feat(server): m-resume-args-helper — buildResumeArgs
  纯函数`
- [x] T3.4. archive `mv changes/m-resume-args-helper
  archive/<date>-m-resume-args-helper` + 回填 hash
- [x] T3.5. spec delta：在 `openspec/specs/sessions/persistence.spec.md`
  Resume 路径段加 "buildResumeArgs helper" 段 + regression Scenario
- [x] T3.6. BACKLOG.md 删 B11

## Commits

- (no matching commits found in git log)
