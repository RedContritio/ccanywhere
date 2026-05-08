# Hooks

## Purpose

cc 的 hook 机制允许在每个生命周期事件（用户提交、工具调用、turn 结束等）执行
任意命令。ccanywhere 把这套机制反向用：服务端给每个 session 注入一份临时的
cc 配置，让 cc 在事件发生时回调本地 HTTP 端点，从而把"cc 当前在做什么"作为
确定性事实驱动 session 状态机——无需根据输出静默猜测。

## Requirements

### Requirement: 临时 CLAUDE_CONFIG_DIR 注入

spawn 一个 session 时，若 `SpawnOptions.hookEndpoint` 存在，manager MUST：

1. 在系统 tmpdir 下创建一个唯一目录（前缀 `ccanywhere-hook-`），权限随系统默认。
2. 在该目录写入 `settings.json`，内容由 `buildHookSettings(sessionId, endpoint)` 给出。
3. 把 `CLAUDE_CONFIG_DIR=<该目录>` 注入 PTY 子进程的环境变量。

PTY 退出时，manager MUST 删除该目录（best-effort，错误不抛）。session 行
的 `markDeleted` 不影响目录清理时机——清理只跟 PTY 退出绑定。

#### Scenario: 退出后目录被清

- GIVEN 一个 session 启动并写入了临时 hook 目录
- WHEN  PTY 退出（自然结束或被 kill）
- THEN  该临时目录在清理后不再存在

#### Scenario: 不存在的目录清理不抛错

- GIVEN 路径指向一个从未存在的目录
- WHEN  调用 `cleanupHookConfigDir(path)`
- THEN  函数返回，不抛错

### Requirement: settings.json 结构

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

#### Scenario: hook 命令含必要元素

- GIVEN `buildHookSettings("abc-123", { host: "127.0.0.1", port: 7878, internalToken: "h…" })`
- WHEN  读取 `Stop` 事件下第一条 hook 的 `command`
- THEN  命令字符串包含 `abc-123`、`internalToken`、`/Stop`
- AND   包含 `http://127.0.0.1:7878/api/hook/`
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
经常误判。状态机由 hook 主导。
