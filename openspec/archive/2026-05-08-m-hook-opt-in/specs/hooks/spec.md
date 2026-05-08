## REMOVED Requirements

### Requirement: 临时 CLAUDE_CONFIG_DIR 注入

（移除原因：注入 `CLAUDE_CONFIG_DIR` 屏蔽了 user 的 `~/.claude/`，导致 cc
子进程看不到用户登录态，每次创建 session 都要重新走 cc 登录。改为
opt-in——见下面 ADDED 的"hook 是 opt-in"。）

## MODIFIED Requirements

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

**关键变化**：服务端**不再** spawn 时把这份配置写入 tmp dir。函数仅作为
**模板**给 user 在 README/CLI 引导下手动复制到 `~/.claude/settings.json`，
属于 opt-in 流程。

(Previously: 服务端 spawn 一个 session 时，若 `SpawnOptions.hookEndpoint`
存在，manager MUST 创建 tmp dir、写 settings.json、注入 `CLAUDE_CONFIG_DIR`
环境变量给 PTY 子进程。)

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

## ADDED Requirements

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
