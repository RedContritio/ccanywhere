# Tasks: M-resume-singleton

## 实施 server

- [ ] T1. `src/session/manager.ts` `SessionManager` 加私有
  `_activeResumeTargets: Map<string, string>` (resumeSessionId → webSessionId)。
- [ ] T2. 定义并 export `SpawnResult` union type；`spawn(opts)` 改签名
  返回 SpawnResult。
- [ ] T3. spawn 内进 attached 早返：if `opts.mode === 'resume'` 且
  map 命中 → 返 `{ kind: 'attached', existingId: <map.get>}`。
- [ ] T4. spawn 成功后：if `opts.mode === 'resume'` → map.set。返回
  `{ kind: 'created', session }`。
- [ ] T5. `SessionImpl.pty.onExit` 内（manager.ts L107 附近）：if
  `info.resumeSessionId !== undefined` → 调一个 manager 提供的
  `releaseResumeLock(resumeSessionId)` callback / 或者 manager 自己 hook
  pty.onExit。两条实现路径任选（推荐：manager 在 spawn 后 attach 一个
  release listener 到 session.on('exit')）。
- [ ] T6. `markDeleted()` 内：同上释放（kill 是异步，markDeleted 同步
  释放避免在 kill 完成前 race）。
- [ ] T7. `gc()` 内：移除 session 时同步释放（健壮性兜底）。

## 实施 server-route

- [ ] T8. `src/server/routes/sessions.ts` `POST /api/sessions` 路径：
  - `manager.spawn(...)` 改 match 返回 union
  - attached: status=200，session 取 `manager.get(existingId)`，
    builds 同样 schema 的 responseBody
  - created: status=201，原路径
  - idempotency store 按实际 status（200 也存，让重放正确）

## 测试 server

- [ ] T9. `src/session/manager.test.ts`（如果不存在则新建）：
  - 'resume 占用同 cc-X 时第二次 spawn 返 attached'
  - 'resume 第一次 exit 后第二次 spawn 创建新 web-session'
  - 'create mode 不占用 resumeTargets'
  - 'markDeleted 立即释放 resumeTargets（不等 PTY exit）'
  - 'gc 释放 resumeTargets'
- [ ] T10. `src/ws/server.test.ts`（或 sessions route 测试）补充集成：
  - 'POST resume 命中已活 web-session 返 200 with existing'

## 实施 client

无代码改动（emergent 行为正确）。

## 验证

- [ ] T11. `pnpm tsc --noEmit` 干净
- [ ] T12. `pnpm vitest run` 全绿（防 regression）
- [ ] T13. `pnpm -C web tsc --noEmit` + `pnpm -C web vitest run` 干净

## Spec delta

- [ ] T14. `specs/sessions/spec.md` 加 Requirement "resume 唯一性"。
- [ ] T15. `specs/rest-api/spec.md` POST /api/sessions：加 200 attach 路径
  + 1 scenario。
- [ ] T16. `specs/web-frontend/spec.md` "新建 session 携带当前主题"
  Requirement：补充 200/201 navigate 行为契约 + scenario "同 device 同 W
  resume 不重 mount"。

## 应用 spec delta

- [ ] T17. 把三处 delta 合并到 `openspec/specs/`。

## 归档

- [ ] T18. `mv openspec/changes/m-resume-singleton openspec/archive/<date>-m-resume-singleton`。
- [ ] T19. dogfood 复测（构造同 cc-X 两次 resume，验证两窗口同步）后用户
  确认 commit。

## Commits

- (no matching commits found in git log)
