## MODIFIED Requirements

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

(Previously: busy 由 PreToolUse / UserPromptSubmit hook 自动驱动，因为
ccanywhere 自动注入了 CLAUDE_CONFIG_DIR + hooks 配置；现在改为 opt-in，
busy 状态的存在依赖 user 手动配置 hook。)

#### Scenario: 不能起死回生

- GIVEN PTY 已退出的 session（`state == 'dead'`）
- WHEN  调用 `setState('idle')`
- THEN  state 保持 `dead`，且不发出 status 事件

#### Scenario: 同状态 setState 静默

- GIVEN session 处于 `busy`
- WHEN  调用 `setState('busy')`
- THEN  不发出 status 事件

#### Scenario: 默认无 hook 配置时不会进入 busy

- GIVEN user 没有在 `~/.claude/settings.json` 配置 ccanywhere 的 hook 段
- WHEN  cc 子进程在执行任意 turn
- THEN  session.state 保持 `idle`（不会被自动切到 `busy`）
- AND   web 终端的状态徽标显示 `idle` 直到 PTY 退出
