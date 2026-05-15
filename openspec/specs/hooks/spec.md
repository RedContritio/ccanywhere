# Hooks

## Purpose

cc 的 hook 机制允许在每个生命周期事件（用户提交、工具调用、turn 结束等）执行
任意命令。ccanywhere 提供一个 hook 接收端点 `/api/hook/:sessionId/:event` 来
驱动 session 状态机。`docs/hooks.md` 提供可复制的 hook 段模板让 user 把它
贴进 `~/.claude/settings.json`。

**自动注入是 opt-out 的**：服务端 **不会** 改 cc 子进程的环境变量，也 **不会**
往 tmp 目录写 settings.json。这样 cc 子进程沿用 user 全局 `~/.claude/`，
保持登录态、最近会话与个人设置。代价是 `busy` 状态默认不可见——user 自行
配置 hook 后才会开启。

## Requirements

### Requirement: hook 是 opt-in

服务端 MUST NOT 在 spawn cc 时修改子进程环境变量。具体：

- MUST NOT 注入 `CLAUDE_CONFIG_DIR`。
- MUST NOT 写 settings.json 到任何 tmp 目录。
- MUST NOT 在 spawn 时为该子进程创建 hook config dir。
- 子进程 MUST 沿用 server 进程的环境（含 `HOME`、`PATH` 等），保证 cc 能读
  user 全局的 `~/.claude/`（auth、本地 settings、history）。

`POST /api/hook/:sessionId/:event` 端点 MUST 仍然存在并按原 state-machine
逻辑工作；这样 user **可以**自行在 `~/.claude/settings.json` 中粘贴
本规范定义的 hook 段（见 `docs/hooks.md`）开启状态机驱动。

#### Scenario: 默认 spawn 继承用户 auth

- GIVEN user 已经在 mac 上跑过 cc 登录，`~/.claude/auth.json` 存在
- WHEN  ccanywhere 通过 web 创建一个 session
- THEN  spawn 的 cc 子进程 MUST 读到 user 的 auth
- AND   web 终端里立刻进入 cc 主界面，不要求重新登录

#### Scenario: 不写 tmp dir

- GIVEN ccanywhere 的 spawn 流程
- WHEN  创建任意 session
- THEN  系统 tmpdir 下 MUST NOT 出现 `ccanywhere-hook-*` 目录

### Requirement: hook 段格式

`~/.claude/settings.json` 内 `hooks` 字段开启 ccanywhere 状态机驱动时，
MUST 为以下事件注册 fire-and-forget HTTP 通知：`SessionStart`、
`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Notification`、`Stop`、
`SubagentStop`。

每个事件下注册一条 `{ type: "command", command: "<curl 调用>" }`，命令
形如：

```
curl -fsS -m 2 -X POST -H "Authorization: Bearer <internalToken>" "<url>" >/dev/null 2>&1 || true
```

`<url>` MUST 为 `http://<host>:<port>/api/hook/$CLAUDE_SESSION_ID/<event>`。
`$CLAUDE_SESSION_ID` 是 cc 在 hook 命令执行时设置的 shell 变量，cc 自身
负责替换成当前 session 的实际 id。

命令 MUST 满足：

- `-m 2` 限制 curl 最多挂 2 秒，避免本地 hook 拖慢 cc。
- `|| true` 吞掉 curl 错误，绝不让 hook 失败影响 cc 主流程。

服务端不在 spawn cc 时自动生成或注入这份 settings.json——user 自愿手贴，
属于 opt-in 流程。模板见 `docs/hooks.md` §2。

#### Scenario: hook 命令含必要元素

- GIVEN `docs/hooks.md` §2 模板
- WHEN  user 把它贴进 `~/.claude/settings.json`，cc 触发 `Stop` 事件
- THEN  cc 实际执行的 command 字符串包含 `$CLAUDE_SESSION_ID` 替换后的 id、
        `internalToken`、`/Stop`
- AND   包含 `http://<host>:<port>/api/hook/`
- AND   包含 `-m 2` 与 `|| true`

### Requirement: hook 事件→状态机映射

服务端收到 `POST /api/hook/:sessionId/:event` 时，按下表驱动 session 状态：

| event              | next state |
|--------------------|------------|
| `SessionStart`     | `idle`     |
| `UserPromptSubmit` | `busy`     |
| `PreToolUse`       | `busy`     |
| `PostToolUse`      | （不切换） |
| `Notification`     | （不切换） |
| `Stop`             | `idle`     |
| `SubagentStop`     | `idle`     |

不切换时仍然 MUST 返回 `204`——hook 已被记录，仅是状态机不变。
session 已死时 setState 是 no-op，所以收到迟到的 hook 不会影响 dead session。

注意：以上映射仅在 user **手动** 配置了 hook 时生效。默认部署下没有 hook
事件源，session.state 保持在 `idle` 直到 PTY 退出。

#### Scenario: PreToolUse 切到 busy

- GIVEN session 处于 `idle`
- WHEN  hook receiver 收到 `PreToolUse`
- THEN  session.state 变为 `busy`
- AND   响应 `204`

#### Scenario: Stop 切回 idle

- GIVEN session 处于 `busy`
- WHEN  hook receiver 收到 `Stop`
- THEN  session.state 变为 `idle`

#### Scenario: Notification 不改 state

- GIVEN session 处于 `busy`
- WHEN  hook receiver 收到 `Notification`
- THEN  session.state 仍为 `busy`
- AND   响应 `204`

### Requirement: hook 不可靠是设计选择

cc 的 hook 是 fire-and-forget HTTP 调用，cc 自身不重试。本服务端
**不补偿** 丢失的 hook 事件（不引入心跳猜测、不引入 RTT 校准）。
某次 `Stop` 丢失时，session.state 会停留在 `busy`，直到下一次 user input
触发新的 hook turn 重置。这是显式接受的 UX 偏差。

延伸：服务端 MUST NOT 根据 PTY 输出静默时间猜测 idle，因 TUI 重绘会让启发式
经常误判。状态机由 hook 主导（user 自愿配置）。

### Requirement: hook 不再做 quota enforcement（m-quota-inline）

m-quota-inline reframe：quota enforcement 已从 `UserPromptSubmit` hook
回环搬到 ws input gate 内嵌；hook 路由仅做 state machine，**不再** 调
UserStore、不再算 ccusage、不再返 block JSON。

`POST /api/hook/:sessionId/:event` 处理器 MUST：

1. 校验 `event` 是 STATE_TRANSITIONS 表内合法事件，否则 `400 invalid_event`。
2. 校验 `session = manager.get(sessionId)` 存在，否则 `404 not_found`。
3. 按 STATE_TRANSITIONS 表执行 setState（不切换的事件保持当前 state）。
4. 始终返 `204 No Content`，**绝不** 返 200 + block JSON。

**MUST NOT**：

- 解析 `session.info.userId`、读 `userStore`、调 `ccusageCalc`、写
  `setQuotaUsage`。这些路径全部在 `QuotaWatcher` + ws input gate 实现。
- 依赖 `UserStore` 注入；hook 路由签名不接受 `userStore` 参数。

#### Scenario: hook UserPromptSubmit 永远 204 + 转 busy

- GIVEN session 处于 `idle`，user 已大幅超 `cost.limitUsd`
- WHEN  POST `/api/hook/<sid>/UserPromptSubmit`
- THEN  状态 `204`
- AND   `session.state === 'busy'`（不再 pre-block hold）
- AND   响应 body 为空，**不** 含 `decision` 字段

### Requirement: quota 实时刷新走 jsonl fs.watch（m-quota-inline）

服务端 MUST 维护一个 `QuotaWatcher`：每个 spawn 的非 owner session 启动
一个 fs.watch 监听该 session 的 `ccJsonlPathOf(cwd, ccSessionId)` 父目录，
debounce 默认 500 ms 后调 `ccusageCalc` 算 jsonl 累计 usage 并通过
`userStore.setQuotaUsage(user.id, costUsd, totalTokens)` 持久化。

watcher MUST：

- owner kind session 不分配 watcher（owner 无 quota，零 fs 开销）。
- session PTY 退出 / markDeleted / killAll 时 close watcher（防 fd 泄漏）。
- 路径派生与原 hook 路径一致：`ccSessionId = info.resumeSessionId ?? info.id`。
- jsonl 不存在时 recompute MUST no-op（不写 setQuotaUsage、不抛错）。
- ccusage 算累计 since `user.createdAt`（与原 hook 行为一致），换发 token
  不重置 quota。

#### Scenario: 非 owner session jsonl 写入触发 quota.used 刷新

- GIVEN user alice spawn 一个 session，ccanywhere 启动 watcher
- WHEN  cc 写 jsonl 行（任意 assistant 行 with usage）
- THEN  约 500 ms 内 `userStore.findById(alice.id).quota.tokens.used` 反映
        `ccusageCalc` 的最新累计

#### Scenario: owner session 不启动 watcher

- GIVEN owner spawn session
- WHEN  cc 写 jsonl 任意量
- THEN  没有 fs.watch entry 被分配
- AND   `userStore.findById(owner.id).quota.cost.usedUsd === 0`

### Requirement: UserPromptSubmit hook stdout 不再要求保留（m-quota-inline）

reframe 之前 UserPromptSubmit hook command MUST 保留 stdout（cc 从 stdout
读 block JSON）；reframe 后 hook 不再返 block JSON，所有事件统一
fire-and-forget，stdout 与 stderr 都可丢弃：

```
curl -fsS -m 2 -X POST -H "Authorization: Bearer <token>" "<url>" >/dev/null 2>&1 || true
```

`docs/hooks.md` 模板里 UserPromptSubmit 仍可保留 stdout（向后兼容旧粘贴
的 settings.json 不破坏），但**不再是必需**。

#### Scenario: UserPromptSubmit hook 漏配 → quota 仍工作

- GIVEN user 的 `~/.claude/settings.json` **没有** UserPromptSubmit hook 配置
- AND   user 已超 `tokens.limit`
- WHEN  user 在 web UI 输入 prompt 触发 ws `input` frame
- THEN  服务端推 `quota_exhausted` server frame，cc 不会收到 input
- AND   `user.quota.tokens.used` 由 `QuotaWatcher` 在 cc 写 jsonl 后异步刷新

### Requirement: 启动期 cc jsonl path encoding sanity check（m-quota-cost-tracking）

服务端启动时 MUST 调 `runStartupSanityCheck` 验 `ccJsonlPathOf` 与 cc CLI
当前的 jsonl 路径编码一致：

1. 扫 `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` 找一个真实 jsonl 路径。
2. 反推 cwd（`-` → `/` 解码），用本实现 `ccJsonlPathOf` 回算 path。
3. 回算 path 与原 path 不一致 → MUST 抛 `QuotaPathError`，server 启动失败
   退出码 `2`，错误消息含 "cc 升级可能改了 path encoding"。
4. `~/.claude/projects` 不存在 / 空 / 无 uuid.jsonl → MUST warn + 跳过
   （新装机器不卡；下次有 jsonl 后 hook 路径自行 self-check）。

#### Scenario: 编码漂移 → fatal 启动失败

- GIVEN `~/.claude/projects/-some-path/<uuid>.jsonl` 存在
- AND   `ccJsonlPathOf` 算出与磁盘文件不一致的路径
- WHEN  server 启动
- THEN  以错误消息（含 "path encoding"）退出，退出码 `2`

#### Scenario: 新装机器 projects 空 → warn 但启动成功

- GIVEN `~/.claude/projects` 不存在或为空
- WHEN  server 启动
- THEN  启动成功（不退出）
- AND   日志含 warn 消息（提示首次 hook fire 时 self-check）
