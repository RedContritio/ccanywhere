# Hooks

## Purpose

cc 的 hook 机制允许在每个生命周期事件（用户提交、工具调用、turn 结束等）执行
任意命令。ccanywhere 提供一个 hook 接收端点 `/api/hook/:sessionId/:event` 来
驱动 session 状态机，并提供 `buildHookSettings()` 模板生成器让 user 把 hook
段贴进 `~/.claude/settings.json`。

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
`buildHookSettings` 生成的 hook 段开启状态机驱动。

#### Scenario: 默认 spawn 继承用户 auth

- GIVEN user 已经在 mac 上跑过 cc 登录，`~/.claude/auth.json` 存在
- WHEN  ccanywhere 通过 web 创建一个 session
- THEN  spawn 的 cc 子进程 MUST 读到 user 的 auth
- AND   web 终端里立刻进入 cc 主界面，不要求重新登录

#### Scenario: 不写 tmp dir

- GIVEN ccanywhere 的 spawn 流程
- WHEN  创建任意 session
- THEN  系统 tmpdir 下 MUST NOT 出现 `ccanywhere-hook-*` 目录

### Requirement: settings.json 模板生成器

`buildHookSettings(sessionId, ep)` MUST 返回符合 cc settings.json hooks 字段
约定的对象，覆盖以下事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、
`PostToolUse`、`Notification`、`Stop`、`SubagentStop`。

每个事件 MUST 注册一条 `{ type: "command", command: "<curl 调用>" }`，命令
形如：

```
curl -fsS -m 2 -X POST -H "Authorization: Bearer <internalToken>" "<url>" >/dev/null 2>&1 || true
```

其中 `<url>` MUST 为 `http://<host>:<port>/api/hook/<urlencoded sessionId>/<event>`。

命令 MUST 满足：

- `-m 2` 限制 curl 最多挂 2 秒，避免本地 hook 拖慢 cc。
- `|| true` 吞掉 curl 错误，绝不让 hook 失败影响 cc 主流程。
- sessionId 走 URL encoding，避免包含 `/` 或空格的 id 把路径切错。

服务端**不再** spawn 时把这份配置写入 tmp dir。函数仅作为 **模板** 给 user
在 README/CLI 引导下手动复制到 `~/.claude/settings.json`，属于 opt-in 流程。

#### Scenario: hook 命令含必要元素

- GIVEN `buildHookSettings("abc-123", { host: "127.0.0.1", port: 62275, internalToken: "h…" })`
- WHEN  读取 `Stop` 事件下第一条 hook 的 `command`
- THEN  命令字符串包含 `abc-123`、`internalToken`、`/Stop`
- AND   包含 `http://127.0.0.1:62275/api/hook/`
- AND   包含 `-m 2` 与 `|| true`

#### Scenario: sessionId 转义

- GIVEN sessionId 含 `/` 与空格，例如 `"a/b c"`
- WHEN  生成 hook 命令
- THEN  命令中相应位置出现 `a%2Fb%20c`

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
