# Proposal: M-hook-opt-in — 不再屏蔽 user cc auth

## Intent

M5 引入 hook 集成时，spawn cc 子进程会注入 `CLAUDE_CONFIG_DIR=<tmp dir>`
让 cc 读 ccanywhere 自己生成的 settings.json（含 hook 配置）。这样做的副作用是
**完全屏蔽了 user 的 `~/.claude/`**——cc 看不到 user 的 auth、最近会话、个人
设置。结果：每次通过 ccanywhere 创建一个 session 都要 user 在浏览器里重新走
一遍 cc 登录，严重不可用。

本提案把 hook 集成从"自动注入"降级为"opt-in"：默认 spawn 不动 cc 配置，子
进程沿用 user 的 `~/.claude/`；想要 hook 驱动状态机的 user 自己在
`~/.claude/settings.json` 里加 hook 段（ccanywhere 提供 endpoint URL 与 token
作为参考）。

## Scope

包含：

- `SessionManager.spawn` 不再创建 tmp dir、不再注入 `CLAUDE_CONFIG_DIR`、
  不再写 settings.json。
- `Session.hookConfigDir`、`SessionManager.hookConfigDirOf` 删除（永远 null
  的字段没价值）。
- `SpawnOptions.hookEndpoint`、`BuildServerOptions.hookEndpoint`、
  `SessionRoutesOptions.hookEndpoint` 三处 lazy factory 删除——它们的唯一用途
  是给 manager 写 settings.json，没用了。
- `cli.ts` 不再回填 `actualPort` 给 hookEndpoint factory；保留 `actualPort`
  仅用于启动日志。
- `POST /api/hook/:sessionId/:event` **保留**——这是接收侧契约，user 手动
  配 hook 后还要往这里打。
- `buildHookSettings(sessionId, ep)` **保留**——给 user 自助配 hook 时复制
  粘贴的模板生成器。
- M8 文档（README + examples）会展示如何把 hook 段加进
  `~/.claude/settings.json`。

不包含（保持现状）：

- hook receiver 路由本身的逻辑（auth、event 校验、状态机映射）不动。
- `internalHookToken` 仍由 cli 启动时生成，作为接收侧鉴权——现在仅在文档里
  暴露给 user 让他粘到 settings.json，不再注入 cc env。
- WebSocket / REST / SPA 等其它能力不受影响。

## Approach

**默认行为变成"无侵入"**：cc 子进程继承 ccanywhere 进程的环境，没有任何
ccanywhere 注入的 env 变量。子进程读 user 全局 `~/.claude/auth.json` 等。

**状态机降级**：原 spec 写"hook event 驱动 state machine"——现在缺少 hook
事件源时，state 仅有：

- `starting` → `idle`（spawn 完成立即设）
- `idle` → `dead`（PTY 退出）
- `busy`：仅当 user 配了 hook 且 hook 路由到达时才会出现

`busy` 状态变得 opt-in，不强制。spec 修订把 hook→state 映射改成"如果 user
配了 hook"的条件性陈述。

**为何不复制 user `~/.claude/` 到 tmp dir**：考虑过拷贝/symlink user 配置 +
追加 hooks 段。但 `~/.claude/` 含项目历史、缓存、token，体量大且包含敏感信息；
对每个 spawn 复制是 IO 开销 + 同步问题（user 主进程改了配置，子进程的副本不
跟）。"opt-in 手动配"是更干净的方案。

**user 操作面**：登录后 cc 在 ~/.claude/ 一次写好 auth；ccanywhere spawn 的
cc 子进程直接拿到 auth；如果 user 想要 ccanywhere 状态显示精确（busy 状态），
按 README 的指引把 hook 段贴到 `~/.claude/settings.json`。
