# Proposal: M-resume-singleton — 同 cc sessionId 的 resume 走 idempotent attach

## Intent

dogfood 反馈 1175e213（2026-05-09）实证：用户在同一设备两次 resume 同一
cc sessionId（`X`），ccanywhere 各 spawn 一个独立 web-session（`W1`, `W2`），
两边各 attach 一个 cc 进程，两个 cc 进程并发写同一份 jsonl history
互相污染（实证：5437 vs 6321 字节两个不同的 server snapshot），且两个
窗口之间不广播同步——因为是 `N web-session : N cc 进程` 而非 ws-protocol
"多 client 广播" 期望的 `1 W : N ws-client`。

cc 上游已知多个相关 bug：

- [#36583](https://github.com/anthropics/claude-code/issues/36583) resume 写
  file-history-snapshot messageId 与 message uuid 冲突，破坏 parentUuid 链
- [#26964](https://github.com/anthropics/claude-code/issues/26964) 同 project
  dir 多个 cc 进程活跃时 jsonl 内容互相 interleave，all event types affected
- [#39667](https://github.com/anthropics/claude-code/issues/39667) silently
  deleted jsonl 导致 --resume 失败

cc 自身**没有文件锁**，依赖外部约束保证同 cc sessionId 单实例。本 task
让 ccanywhere server 担起这个约束：

- 同 cc sessionId（`X`）任意时刻 MUST 至多被一个未 dead 的 web-session
  占用。
- 第二次 `POST /api/sessions { mode: 'resume', sessionId: X }` MUST 不
  spawn 新 cc，而是 idempotent attach 到现有 web-session（返 `200 OK` +
  现有 W 的 session 行）。
- 客户端 navigate 到现有 W；ws-protocol 已实现的"多 client 广播"自然
  让多个浏览器窗口同步 PTY 输出与 input。

## 设计要点

### server-side singleton

`SessionManager` 加 `_activeResumeTargets: Map<resumeSessionId, webSessionId>`：

- spawn 之前 if `opts.mode === 'resume'` 且 `_activeResumeTargets.has(opts.resumeSessionId)`
  → 不 spawn，返回 attached 结果。
- spawn 成功后 if `opts.mode === 'resume'` → `_activeResumeTargets.set(opts.resumeSessionId, info.id)`。
- 释放时机：
  - `pty.onExit`：cc 进程死了，sessionId 可被新 web-session resume。
  - `markDeleted`：用户 DELETE 一个 web-session，立即释放（不等 PTY 完
    全 exit；markDeleted 已经触发 kill）。
  - `gc()`：dead session 被 ttl 回收时，无视 deletedAt 状态强制删一次（健壮
    性，理论上 onExit/markDeleted 已 cover）。

### spawn 返回 union

```ts
type SpawnResult =
  | { kind: 'created'; session: Session }
  | { kind: 'attached'; existingId: string }

spawn(opts: SpawnOptions): SpawnResult
```

调用方必须 match。这破坏旧签名（之前直接返 Session），但 spawn 只在
`POST /api/sessions` 路由内被调，集中改一处。

### 与 #12 M-restart-dead 的概念边界

- restart-dead = **同 web-session id** 内重启 cc（旧 PTY dead → spawn
  新 PTY，可能 --resume 自己之前的 sessionId 接续历史）
- resume = 创建**新** web-session attach 历史

restart-dead 不应被 singleton 拦截：
- 旧 cc dead 时 `pty.onExit` 已经 `_activeResumeTargets.delete(resumeSessionId)`，
  释放 lock
- restart 路径 spawn 新 cc 时 lock 是空的，正常占用
- 如果 #12 实施时 dead session 没立刻 onExit（异步），可能需要 #12 在
  spawn 新 cc 前显式 release——具体由 #12 task 协调

### 同 device 同 cc-X 二次 resume 的 client 行为

react-router-dom v6 navigate 到当前 path = noop。`workspace.tsx:301`
`<TerminalView key={currentSession.id}>` 在 W 不变时不 unmount。所以：

- device D 已在 `/workspace/W1`，用户又点 history 里的 cc-X resume
- POST → 200 + W1
- client navigate(`/workspace/W1`) = noop
- 用户体感：dialog 关闭，已经在那个 session 上

**不需要前端新代码**——server 改完 client 侧 emergent 行为正确。

### 不同 device 同 cc-X 的多端访问

- device E 第一次访问，POST resume X → 200 + W1
- E navigate(`/workspace/W1`)，TerminalView mount → ws connect
- ws server `bundle.clients.add(E_sock)` + pendingClients gate（`#28` 已
  保证 snapshot 第一帧）
- E 收到 W1 当下 screenState snapshot，加入 multi-client broadcast
- D 与 E 都能 input，cc 收到来自两个 ws-client 的合流（这是 ws-protocol
  接受的语义；input 冲突属于 multi-client 固有问题，留给 #19 readonly-watch
  的 owner/observer 角色设计解决）

## Scope

### server-side

- `src/session/manager.ts`：`_activeResumeTargets` Map + `spawn` 返回
  union + `pty.onExit` / `markDeleted` / `gc()` 释放。
- `src/server/routes/sessions.ts` `POST /api/sessions` 路径：spawn 返回
  match → 200/201 分支，idempotency store 按实际 status 存。
- 测试 `src/session/manager.test.ts` + `src/server/routes/sessions.test.ts`
  （或 ws/sessions 集成测试）：
  - resume 命中 attach 返 existing
  - exit / markDeleted 后 lock 释放，二次 resume 成功 spawn 新
  - create mode 不 touch lock
  - mode='resume' 但 sessionId 是新的（首次）正常 spawn 并占用 lock
  - GC 释放 lock

### client-side

无代码改动（emergent 行为正确），测试不需要新加。

### spec delta

- `sessions/spec.md` 加 Requirement "resume 唯一性"
- `rest-api/spec.md` `POST /api/sessions` 加 200 attach 路径 + 1 scenario
- `web-frontend/spec.md` "新建 session 携带当前主题" 段加 navigate 行为
  契约

## Out of scope

- input 冲突的 owner/observer 角色（→ #19 M-device-readonly-watch）
- 同 cwd 多个 cc 进程的 jsonl 污染（cc 上游 #26964；本 task 只 cover
  同 sessionId resume）
- restart-dead 路径的 lock 协调（→ #12 M-restart-dead 实施时处理）

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 同 cc sessionId 任意时刻 ≤ 1 cc 进程占用 | `_activeResumeTargets` 是 SessionManager 唯一 spawn entrance；释放绑 onExit/markDeleted/gc 三处全 cover |
| 第二次 resume 同 cc-X 不 spawn 新 cc | spawn 内 attached 路径不调 ptySpawn |
| restart-dead 不被 singleton 误拦 | onExit 释放在 setState('dead') 之前的 emit('exit') 路径里，dead session 自然不占 lock |
| 多 device 同 W 通过 ws multi-client 广播同步 | ws-protocol Requirement "多 client 广播" 已实现；resume singleton 把 N web-session 塌成 1 W 后自然走该路径 |
| client 同 W navigate 是 noop（不重 mount） | react-router v6 path 不变 = noop；`<TerminalView key={W}>` key 不变不 unmount |
