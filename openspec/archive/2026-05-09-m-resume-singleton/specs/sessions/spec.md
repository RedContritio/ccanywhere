## ADDED Requirements

### Requirement: resume 唯一性

`SessionManager` MUST 维护内部 `activeResumeTargets: Map<resumeSessionId,
webSessionId>`，跟踪当前被某个未 dead 的 web-session 占用的 cc sessionId
集合。该集合 MUST：

- 在 `spawn(opts)` 内（且仅在该函数）读写：
  - 进入函数后若 `opts.mode === 'resume'` 且 `opts.resumeSessionId` 命中
    map：MUST 进一步校验该 webSessionId 对应的 SessionImpl 仍 **active**
    （`existing.deletedAt === null && existing.state !== 'dead'`）。
    - 校验通过 → MUST NOT 调 `ptySpawn`；MUST 返
      `{ kind: 'attached', existingId }`。
    - 校验失败（候选已 deleted 或 dead）→ MUST 把 map 中该 stale entry
      `delete` 掉，fallthrough 到正常 spawn 路径。这覆盖了 markDeleted →
      kill → PTY exit 的异步窗口期：lock 由 onExit 异步释放，但用户在该
      窗口内重新 resume 同 cc-X 时 spawn 会自动清掉 stale lock 然后开新 cc。
  - 正常 spawn 路径完成后，if `opts.mode === 'resume'` MUST
    `activeResumeTargets.set(opts.resumeSessionId, session.info.id)`。
- 释放 lock 通过 `session.on('exit', ...)` 完成：spawn(resume) 成功后 MUST
  注册一个 exit listener，listener 内 `if (activeResumeTargets.get(resume
  SessionId) === session.info.id) activeResumeTargets.delete(resumeSessionId)`。
  身份校验（`=== session.info.id`）防止同 resumeSessionId 已被新 webSession
  接管时旧 listener 误删新 entry。

`spawn` 返回类型 MUST 是 discriminated union：

```ts
type SpawnResult =
  | { kind: 'created'; session: Session }
  | { kind: 'attached'; existingId: string };
```

调用方（仅 `POST /api/sessions` 路由）MUST 显式 match 处理两路径——
attached 时不需要任何 SessionImpl 构造、也不消耗 idempotency 资源
（同一 cc-X 第二次 resume 是 idempotent 的）。

不变量：

- `activeResumeTargets` 中的每个 entry 在被 spawn 内 attached 路径**返回
  之前**的 active 校验后才被使用——map 本身可以含 stale entry（onExit 异步
  释放窗口期内），但永远不会 leak 给调用方。
- 同一 `resumeSessionId` 在 map 中至多有一个 entry。
- 同一 resumeSessionId 任意时刻最多只有 1 个 cc 进程被 ccanywhere spawn
  着——这是本 Requirement 的核心契约，由"spawn 内 attached 路径短路 +
  active 校验拒绝 stale" 共同保证。

#### Scenario: resume 同 cc-X 第二次 attach 不 spawn 新 cc

- GIVEN web-session `W1` 由 `spawn({mode:'resume', resumeSessionId:'X'})`
  创建并 active（state=`idle`，deletedAt=null）
- WHEN  `spawn({mode:'resume', resumeSessionId:'X'})` 第二次被调
- THEN  返 `{ kind: 'attached', existingId: 'W1' }`
- AND   `manager.list().length` 不变
- AND   `ptySpawn` 在第二次调用中 MUST NOT 被调用

#### Scenario: pty exit 后释放 lock，第三次 resume 能 spawn 新

- GIVEN `W1` 占用着 cc-X，`activeResumeTargets.get('X') === 'W1'`
- WHEN  `W1` 的 PTY 退出（`pty.onExit` fired，emit `'exit'` event）
- THEN  spawn 时注册的 exit listener 触发 `activeResumeTargets.delete('X')`
- AND   后续 `spawn({mode:'resume', resumeSessionId:'X'})` 返
        `{ kind: 'created', session }` 且 session.info.id !== W1

#### Scenario: markDeleted 后立即 resume 自动清 stale lock

- GIVEN `W1` 占用着 cc-X，`W1.markDeleted()` 刚被调（deletedAt!=null，
        但 PTY 仍在 dying，exit listener 还没 fire）
- WHEN  立即在同一同步 task 内调 `spawn({mode:'resume', resumeSessionId:'X'})`
- THEN  spawn 看到 map.get('X')==='W1'，但 W1.deletedAt!==null → active
        校验失败
- AND   spawn 把 map.entry('X') 清掉，fallthrough 到正常 spawn 路径
- AND   返 `{ kind: 'created', session }` with 新 W2 id
- AND   `activeResumeTargets.get('X') === 'W2'`（lock 由 W2 重新占用）

#### Scenario: create mode 不 touch lock

- GIVEN `activeResumeTargets` 当前为空
- WHEN  `spawn({mode:'create', projectId:'p', ...})`
- THEN  返 `{ kind: 'created', session }`
- AND   `activeResumeTargets` 仍为空
- AND   exit listener 也不注册（create 路径无 lock 概念）

#### Scenario: 同 resumeSessionId 已被新 W 接管时旧 exit 不误删

- GIVEN `W1` 占用着 cc-X，markDeleted 触发 kill，但 PTY 尚未 exit
- AND   用户立即 resume cc-X：spawn 清掉 stale lock，spawn 新 W2，map.set
        ('X', 'W2')
- WHEN  原 W1 的 PTY 终于 exit，旧 exit listener fire
- THEN  listener 校验 `activeResumeTargets.get('X') === 'W1'` → false（值
        是 'W2'）
- AND   listener `activeResumeTargets.delete('X')` MUST NOT 执行（保留 W2
        的 lock）
- AND   后续 spawn(resume X) 仍命中 W2 attached
