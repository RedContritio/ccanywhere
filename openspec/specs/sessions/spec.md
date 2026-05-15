# Sessions

## Purpose

一个 session 是依附到某项目 cwd 的 cc 子进程，通过 PTY 暴露给 web 客户端。
session 的生命周期长于浏览器标签页（关闭笔记本上的标签后用手机能重新接回），
也长于 PTY 进程本身（让 DELETE 在弱网络下天然幂等）。

跨 server 重启的持久化（dead stub registry / boot 加载 / shutdown 时序 /
resume 路径 / F1-F5 保证）拆分到 [persistence.spec.md](./persistence.spec.md)。

## Requirements

### Requirement: 用户隔离（m-multi-user）

每个 PTY session MUST 在 spawn 时绑当前请求的 `req.user.id`（写入
`SessionInfo.userId`）。所有 session 操作 MUST 按 user 隔离：

- `POST /api/sessions` MUST 通过 `resolveProjectStore(req.user)` 解析对应
  user 的 ProjectStore 查 `projectId`；找不到返 `404 not_found`（store
  隔离 first line，跨 user 项目 id mask 为不存在）。defense-in-depth：
  cwd MUST 落在 `UserStore.projectsRootFor(req.user)` 子树内（默认
  `<workspace>/<username>/`，可被 `users.<name>.workspace` override；
  m-user-symmetric），否则 `403 forbidden`。
- `GET /api/sessions` MUST 仅返回 `session.info.userId === req.user.id`
  的条目。
- `DELETE /api/sessions/:id` MUST 在 `session.info.userId !== req.user.id`
  时返回 `404 not_found`（与不存在 id 一致，避免泄露 session 归属）。
- `/ws/sessions/:id` upgrade MUST 在 cross-user 时 `sock.close(1008)`
  并发 `error` 帧（mask 为 not-found，统一 close code 语义）。

#### Scenario: 跨 user 用 owner project id → 404 not_found（store 隔离）

- GIVEN user alice 已 token 登录，cookie 已带
- AND   project `demo` 在 owner 项目根，alice 的 store 中不含此 id
- WHEN  alice `POST /api/sessions { projectId: 'demo', mode: create }`
- THEN  返回 `404` + body `{ error.code: 'not_found' }`（store 隔离 first
  line 在 cwd guard 之前 trip；m-user-symmetric）

#### Scenario: 跨 user 不能看到对方的 sessions

- GIVEN alice 创建 sessionA；bob 创建 sessionB
- WHEN  alice `GET /api/sessions`
- THEN  仅返回 sessionA

### Requirement: session 标识与创建

session MUST 拥有：服务端生成的 UUIDv4 `id`、当前可见 `ProjectStore` 中
存在的 `projectId`、`mode`（`create` 或 `resume`）、epoch-ms 时间戳
`createdAt`。当 `mode = resume` 时还 MUST 设置 `resumeSessionId`。

session MUST 以下列方式 spawn：PTY 列数（默认 100）、行数（默认 30）、
`name = "xterm-256color"`、cwd 取自 `ProjectStore.get(projectId).cwd`、
二进制取自 `config.claudeBin`。

#### Scenario: create session 没有 resumeSessionId

- GIVEN `POST /api/sessions` 请求 body 含 `mode: "create"`
- WHEN  session 被创建
- THEN  `info.resumeSessionId` 为 `undefined`
- AND   响应 body 中 `resumeSessionId` 为 `null`

#### Scenario: resume session 记录 sessionId

- GIVEN `POST /api/sessions` 请求 body 含 `mode: "resume", sessionId: "abc"`
- AND   `"abc"` 出现在 `listHistory(project.cwd)` 的结果中
- WHEN  session 被创建
- THEN  `info.resumeSessionId == "abc"`
- AND   cc 子进程的 argv 包含 `--resume abc`

### Requirement: 生命周期状态

session MUST 有 `state` 字段，取值 `starting | idle | busy | dead`：

- `starting`：从构造到第一次 `setState('idle')` 之间。
- `idle`：cc 等待用户输入，**或**没有 hook 反馈源时的默认非死状态。
- `busy`：cc 正在执行一个 turn——**仅在 user 自行配置了 cc hook**（见
  `hooks/spec.md`）的情况下才会出现。无 hook 配置时 state 不进入 busy。
- `dead`：PTY 已退出，终态——不再有出向转换。

session 还 MUST 有 `deletedAt: number | null` 字段，与 `state` 独立。
`deletedAt` 仅由用户主动 DELETE 设置一次，永不清空。

`state == 'dead'` 后，所有状态切换 MUST 是 no-op。把 state 设为当前值
MUST NOT 触发 status 事件。

#### Scenario: 不能起死回生

- GIVEN PTY 已退出的 session（`state == 'dead'`）
- WHEN  调用 `setState('idle')`
- THEN  state 保持 `dead`，且不发出 status 事件

#### Scenario: 同状态 setState 静默

- GIVEN session 处于 `busy`
- WHEN  调用 `setState('busy')`
- THEN  不发出 status 事件

### Requirement: session 进程死后仍保留

PTY 退出时，session 行 MUST 仍存在于 manager 的 map 中，
`state == 'dead'`，`deletedAt` 不变。这是 DELETE 幂等与客户端看到一致历史
列表的前置条件。

manager MUST 在 PTY 退出时清理 session 的临时 `CLAUDE_CONFIG_DIR`（如有），
但 MUST NOT 移除 session 记录。

#### Scenario: 死 session 仍可列

- GIVEN 一个被 kill 的 session
- WHEN  调用 `manager.list()`
- THEN  返回数组中仍包含该 session
- AND   其 `state` 为 `dead`，`deletedAt` 为 `null`

### Requirement: markDeleted 幂等

`session.markDeleted()` MUST：首次调用设置 `deletedAt = Date.now()`，
若 PTY 还活着则触发 kill；后续调用 MUST 是 no-op（`deletedAt` 时间戳不变）。

#### Scenario: 二次 markDeleted 是 no-op

- GIVEN session 的 `deletedAt = T`
- WHEN  再次调用 `markDeleted()`
- THEN  `deletedAt` 仍为 `T`
- AND   不再发送额外 kill 信号

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

理由：cc CLI 本身没有 jsonl 文件锁，多个 cc 进程并发 `--resume <X>` 会
互相覆盖 `~/.claude/projects/<cwd>/<X>.jsonl` 历史
（[anthropics/claude-code#26964](https://github.com/anthropics/claude-code/issues/26964)、
[#36583](https://github.com/anthropics/claude-code/issues/36583)）。
ccanywhere 在 server 层兜住单实例约束。

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

### Requirement: active vs all 列表

manager MUST 暴露两个读方法：

- `list()`：返回**所有** session（含 dead、含 deleted）。
- `listActive()`：仅返回 `deletedAt === null` 的 session。

调用方需要自觉选择；"active" 包含"PTY 已死但用户未删除"的 session
（cc 崩溃但用户没主动删除的情形）。

### Requirement: kill 阶梯

`session.kill()` MUST 按递增强度发信号，每一步都先检查 PTY 是否还活：

1. 立即发 `SIGINT`。
2. 2,000 ms 后发 `SIGTERM`。
3. 7,000 ms 后发 `SIGKILL`（即 SIGTERM 之后 5,000 ms）。

返回的 promise MUST 在 PTY 发出 exit 事件后 resolve。多个并发的 `kill()` 调用
MUST 共享同一个 exit promise，MUST NOT 重复发信号。

#### Scenario: kill 已死的 session 立即返回

- GIVEN session 处于 `dead`
- WHEN  调用 `kill()`
- THEN  返回的 promise 立即 resolve，且不发任何信号

### Requirement: resize 校验

`session.resize(cols, rows)` MUST 在任一参数小于 1 时抛 `RangeError`。
session 已死时 resize MUST 是 no-op。

#### Scenario: 负数 rows 被拒绝

- GIVEN 一个活 session
- WHEN  调用 `resize(80, -1)`
- THEN  抛 `RangeError`

### Requirement: scrollback ring buffer

每个 session MUST 拥有一个按字节数限定的 scrollback 缓冲区
（配置项 `scrollbackBytes`，默认 1 MiB，下限 1 KiB）。PTY 数据 MUST 追加进去；
溢出时 MUST 按 FIFO 丢弃最旧 chunk。单个超过容量的 chunk MUST 从尾部截断到
正好等于容量。

scrollback MUST 暴露两个 cumulative byte counter（session 生命周期内单调
递增，**不**因 ring 滑动而重置）：

- `headSeq`：自创建以来 PTY 写入到 scrollback 的总字节数（"已写入"边界）。
- `tailSeq`：被 FIFO 丢弃的累积字节数（"已 evict"边界）。

不变量：`tailSeq <= headSeq`，且 `bytes == headSeq - tailSeq`（buffer 内的字节数）。

scrollback MUST 暴露：

- `snapshot(): string` — 返回当前缓冲区的 UTF-8 字符串（buffer 内全部内容）。
- `since(seq: number): string | null` — 返回字节序列 `[seq, headSeq)` 的内容；
  当 `seq < tailSeq`（数据已 evict）时 MUST 返回 `null`；当 `seq >= headSeq`
  时 MUST 返回 `''`；当 `tailSeq <= seq < headSeq` 时 MUST 返回对应子串。

`clear()` MUST 清空 buffer 内字节但 **不** 重置 `headSeq`（保持 session-wide
单调递增，让残留的客户端 `lastSeq` 自然降级到 fallback 而不会"穿越"reset）。
`tailSeq` 在 clear 后 MUST 等于 `headSeq`（buffer 为空）。

#### Scenario: FIFO 丢弃保留最近数据

- GIVEN 1024 字节的 scrollback，先写入大量旧 chunk，再写一个 `TAIL_MARKER`
- WHEN  读取 `snapshot()`
- THEN  结果以 `TAIL_MARKER` 结尾

#### Scenario: 单个超大 chunk 保留尾部

- GIVEN 全新的 1024 字节 scrollback
- WHEN  以一个 chunk 写入 5,000 个 `'a'`
- THEN  `bytes` 等于 1024
- AND   `snapshot()` 是恰好 1024 个 `'a'` 字符

#### Scenario: since 命中 ring 内

- GIVEN scrollback 写入 `"ABC"` 后 `"DEF"`（`headSeq == 6`，`tailSeq == 0`）
- WHEN  调用 `since(3)`
- THEN  返回 `"DEF"`

#### Scenario: since 越过 evict 边界返 null

- GIVEN scrollback 已发生 FIFO 丢弃，`tailSeq == 100`
- WHEN  调用 `since(50)`
- THEN  返回 `null`

#### Scenario: clear 不重置 headSeq

- GIVEN scrollback 当前 `headSeq == 1000`
- WHEN  调用 `clear()`
- THEN  `bytes == 0` 且 `tailSeq == 1000` 且 `headSeq == 1000`
- AND   后续写入字节会让 `headSeq` 继续增长

### Requirement: server-side 屏幕镜像（screenState）

每个 session MUST 维护一个 server-side 屏幕镜像，用于在 WebSocket 重连且
`lastSeq == 0` 或 `lastSeq <= scrollback.tailSeq` 时给客户端返回一份正确的
snapshot 帧。

实现 MUST 用 `@xterm/headless` 的 `Terminal` + `@xterm/addon-serialize` 的
`SerializeAddon`：

- session spawn 时构造 headless terminal（cols/rows 取 spawn 入参）。
- 每次 PTY data MUST 同步 `term.write(data)`。
- session.resize MUST 同步 `term.resize(cols, rows)`。
- session exit 时 MUST `term.dispose()` 释放 heap。

`screenState.snapshot(): string` MUST 返回 SerializeAddon 序列化的 minimal-ANSI
（含 cursor 位置、alt-screen 切换、当前 grid 单元的 SGR 与字符），客户端
xterm `term.write(snapshot)` 后 MUST 渲染出与服务端等效的可见屏幕。

不直接发 raw scrollback bytes 作 snapshot 的原因：(a) ring 截断在 ANSI escape
中间会让客户端 parser 错乱；(b) 历史 cursor moves 在新 cols/rows 下重放会错位。

#### Scenario: PTY 数据同步进 screenState

- GIVEN session 已 spawn
- WHEN  PTY 写入 `"hello"`
- THEN  `screenState.snapshot()` 含 `"hello"` 在 cursor 之前

#### Scenario: resize 同步到 screenState

- GIVEN session 当前 80×24
- WHEN  调用 `session.resize(120, 30)`
- THEN  `screenState` 的 cols/rows 为 120×30
- AND   后续 `screenState.snapshot()` 反映新尺寸下的布局

### Requirement: PTY data 分片追踪

每个 session MUST 在 PTY `onData` 时 append 一条诊断记录到一个 session
生命周期内 append-only 的数组。该追踪与 scrollback / screenState 正交，
**仅用于反馈诊断**：让 feedback record 中的 `serverSession.recentDataChunks`
与客户端 `diag.term.screen` / `ops` trace 可三方对位还原 cc 输出时序
（识别 cc Ink TUI 同 chunk 重发 / scrollback 重画等上游行为）。

`Session` 接口 MUST 暴露：

```ts
interface Session {
  // ... existing fields ...
  readonly lastDataAt: number | null;     // 最近一次 onData 的 epoch-ms
  readonly exitCode: number | null;       // PTY 退出码（state == 'dead' 才有）
  readonly recentDataChunks: readonly PtyDataChunkRecord[];
}

interface PtyDataChunkRecord {
  readonly ts: number;       // epoch-ms
  readonly len: number;      // chunk 总字节数
  readonly head: string;     // chunk 前 32 字节 hex-escaped
                              // 控制字节展开为 \xNN
}
```

不变量：

- `recentDataChunks` MUST 是 append-only：每次 PTY `onData` 追加一条
  记录，session 生命周期内不裁剪、不重排。
- exit 时 MUST NOT 清空——dead session 在 GC 之前仍可被反馈引用。
- session GC 移除其 manager 行时 MUST 释放该数组（随 SessionImpl 实例）。
- `lastDataAt` 等于 `recentDataChunks` 末尾 record 的 `ts`（若数组非空）。
- `exitCode` MUST 在 `pty.onExit` 时设置；`null` 表示 PTY 未退出。

`head` 编码：原始字节中 ASCII 可见区直出，控制字节（`\x00`-`\x1f` /
`\x7f`）转 `\xNN`。32 字节上限是为了让单条 record 在 JSON 序列化后
~100 B（chunk 末段不含），全长 chunk 仍可由 `len` 比对客户端测量值。

内存：cc idle 状态约 10 chunks/s × ~100 B = ~5 MB/小时；`busy` 高峰
约翻倍。dogfood 单 session 寿命典型 < 24h，不需要裁剪。后续若长寿
session 触及内存压力，可在写入处按 byte cap 裁剪（保留尾部 N 条），
**不影响契约语义**——消费者按"append-only 不重排"读取即可。

#### Scenario: 每条 PTY chunk 落一条 record

- GIVEN session 已 spawn
- WHEN  PTY 发出 `"hello\n"`（6 字节）
- THEN  `recentDataChunks` 末尾新增一条 `{ ts, len: 6, head: "hello\\n" }`
- AND   `lastDataAt === ts`

#### Scenario: 控制字节在 head 中 hex-escaped

- GIVEN PTY 发出 `"\x1b[2J"`（4 字节，alt-screen 清屏）
- WHEN  追加进 `recentDataChunks`
- THEN  `head === "\\x1b[2J"`（而非原始 ESC 字符）
- AND   `len === 4`

#### Scenario: dead session 仍保留历史 chunks

- GIVEN session 已 exit，`exitCode = 0`
- WHEN  在 GC 之前读 `recentDataChunks`
- THEN  仍返回 spawn 以来的全部 record
- AND   session 行被 GC 后 `manager.get(id)` 返回 `undefined`，引用一并释放

#### Scenario: chunk 超 32 字节仅记录 head

- GIVEN PTY 发出一个 1000 字节 chunk
- WHEN  追加进 `recentDataChunks`
- THEN  record 的 `len === 1000`
- AND   `head` 长度 ≤ 32 字节（hex-escaped 后字符数可能略大于 32）

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

### Requirement: deleted session 的 GC

manager MUST 按 `config.deletedSessionTtlMs` 回收已软删除的 session。
回收意味着把该 session 行从 manager 内部 map 中物理移除——之后
`get(id)` 返回 `undefined`，`list()` / `listActive()` 不再包含。

回收触发时机 MUST 限于"活动入口"：

- `manager.spawn()` 进入。
- `manager.list()` 进入。
- `manager.listActive()` 进入。

回收条件：`session.deletedAt !== null` 且
`session.deletedAt + config.deletedSessionTtlMs < Date.now()`。

回收 MUST NOT 由独立后台 timer 触发。idle 状态下不跑 GC 是允许的——
没有访问意味着没有观察者关心 session 是否还在 map 里。

#### Scenario: 未到期不动

- GIVEN session 被 markDeleted，距今 5 分钟（< 10 分钟默认 TTL）
- WHEN  调用 `manager.list()`
- THEN  该 session 仍在返回数组中

#### Scenario: 过期被回收

- GIVEN session 被 markDeleted，距今 15 分钟（> 10 分钟默认 TTL）
- WHEN  调用 `manager.list()`
- THEN  该 session 不在返回数组中
- AND   `manager.get(sessionId)` 返回 `undefined`

#### Scenario: 活的 session 不受影响

- GIVEN session 处于 `idle`，`deletedAt === null`
- WHEN  时间流逝任意长度
- THEN  该 session 仍在 `listActive()` 返回中
- AND   `markDeleted` 之后才有资格被 GC 回收
