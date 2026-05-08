# Sessions

## Purpose

一个 session 是依附到某项目 cwd 的 cc 子进程，通过 PTY 暴露给 web 客户端。
session 的生命周期长于浏览器标签页（关闭笔记本上的标签后用手机能重新接回），
也长于 PTY 进程本身（让 DELETE 在弱网络下天然幂等）。

## Requirements

### Requirement: session 标识与创建

session MUST 拥有：服务端生成的 UUIDv4 `id`、当前可见 `ProjectStore` 中
存在的 `projectId`、`mode`（`fresh` 或 `resume`）、epoch-ms 时间戳
`createdAt`。当 `mode = resume` 时还 MUST 设置 `resumeSessionId`。

session MUST 以下列方式 spawn：PTY 列数（默认 100）、行数（默认 30）、
`name = "xterm-256color"`、cwd 取自 `ProjectStore.get(projectId).cwd`、
二进制取自 `config.claudeBin`。

#### Scenario: fresh session 没有 resumeSessionId

- GIVEN `POST /api/sessions` 请求 body 含 `mode: "fresh"`
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

`scrollback.snapshot()` MUST 返回当前缓冲区的 UTF-8 字符串。

#### Scenario: FIFO 丢弃保留最近数据

- GIVEN 1024 字节的 scrollback，先写入大量旧 chunk，再写一个 `TAIL_MARKER`
- WHEN  读取 `snapshot()`
- THEN  结果以 `TAIL_MARKER` 结尾

#### Scenario: 单个超大 chunk 保留尾部

- GIVEN 全新的 1024 字节 scrollback
- WHEN  以一个 chunk 写入 5,000 个 `'a'`
- THEN  `bytes` 等于 1024
- AND   `snapshot()` 是恰好 1024 个 `'a'` 字符

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
