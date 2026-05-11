# CLI 命令族 spec

`ccanywhere` mac CLI 的所有子命令契约。仅记录稳定面（subcommand / flag /
退出码 / 持久化文件位置）；具体输出格式 / HELP 文本随实现演化不锁。

## 通用规则

- 全局 flag `--config <path>` 接 `<configDir>/config.json`，缺省走
  `defaultConfigPath()`（`$CCANYWHERE_CONFIG` / `$XDG_CONFIG_HOME/ccanywhere/
  config.json` / `~/.config/ccanywhere/config.json`）
- 子命令未明确指定时默认 `serve`
- 退出码：0 成功 / 1 运行时错误（含 fs / network / 找不到资源）/ 2
  CLI usage 错误（命令缺参 / 未知子命令）

## Requirement: serve / approve / devices / revoke / user / token

以下 subcommand 由 `serve`、`auth-multi-user`、device pair 等 spec 各自
覆盖契约（route auth.spec.md / auth-multi-user 相关）；CLI 表面：

```
ccanywhere [serve] [--config <path>]
ccanywhere approve [--config <path>]
ccanywhere devices [--config <path>]
ccanywhere revoke [--config <path>] <device-id>
ccanywhere user create <username> [--ttl 7d] [--cost-usd N] [--tokens N]
ccanywhere user list
ccanywhere user quota set <username> [--cost-usd N] [--tokens N] [--reset]
ccanywhere token issue <username> [--ttl 7d] [--label <s>]
ccanywhere token list [--user <name>]
ccanywhere token revoke <token-id>
```

详细行为见对应 spec area。

## Requirement: feedback subcommand

`ccanywhere feedback` 子命令族支持 owner 在 mac 终端 review web 端用户
反馈。状态文件 `<configDir>/feedback-seen.json` 持久化"已读" set，使
默认 `list` 输出仅含未读，避免重复审阅。

```
ccanywhere feedback list [--verbose] [--json] [--all]
ccanywhere feedback show <id-prefix> [--full] [--no-mark]
ccanywhere feedback mark-seen <id-prefix>
ccanywhere feedback mark-all-seen
ccanywhere feedback forget <id-prefix>
```

CLI MUST：

- `list` 默认仅列**未 seen** 的 feedback，按时间倒序；`--all` 列全部
  并用前缀字符（如 `★`）标 unread，三空格 padding 标 seen
- `list` 输出格式由 `--verbose` (扩展字段) / `--json` (JSON 数组) 控制；
  默认 tabular
- `show <id-prefix>` 自动 `mark-seen` 一次（`--no-mark` skip）；模糊
  匹配 id-prefix，多匹配返候选 + exit 1，无匹配 exit 1
- `show --full` dump 整个 envelope 的 pretty JSON，否则 summary（含
  diag 关键字段 + ops 直方图 top 10）
- `mark-seen <id-prefix>` 单笔添加 seen；`mark-all-seen` 全 feedback
  目录扫描；`forget <id-prefix>` 反向移除
- 状态文件 `<configDir>/feedback-seen.json` 形状 `{ "seen": string[] }`，
  mode `0o600`，sort 后 JSON.stringify（dotfiles 友好）；missing /
  malformed 视为空集（fallback 非阻塞）
- 反馈文件本身仍在 `<configDir>/feedback/<id>.json` (POST /api/feedback
  写入，本 spec 不重描)

### Scenario: 默认 list 跳过已读

- GIVEN `<configDir>/feedback/A.json` `B.json` `C.json` 各 1 笔
- GIVEN `<configDir>/feedback-seen.json` 含 `["A", "B"]`
- WHEN `ccanywhere feedback list`
- THEN 仅输出 `C` 一笔

### Scenario: show 自动标记

- GIVEN 反馈 `A` 未 seen
- WHEN `ccanywhere feedback show A`（exit 0）
- THEN feedback-seen.json 含 `"A"`，`ccanywhere feedback list` 不再列 A

### Scenario: --no-mark 仅 peek

- GIVEN 反馈 `A` 未 seen
- WHEN `ccanywhere feedback show A --no-mark`
- THEN feedback-seen.json 不含 A；后续 list 仍列 A

### Scenario: malformed feedback-seen.json 不致 crash

- GIVEN `<configDir>/feedback-seen.json` 含 `not-json`
- WHEN `ccanywhere feedback list`
- THEN 视为空 seen 集；list 输出全部反馈；不抛错

### Scenario: mark-all-seen 一键清空 unread

- GIVEN N 笔反馈未 seen
- WHEN `ccanywhere feedback mark-all-seen`
- THEN 输出 `marked N new seen (total seen: N)`；后续 list 默认 → "(no unread feedback)"

### Scenario: forget 反转

- GIVEN 反馈 `A` 已 seen
- WHEN `ccanywhere feedback forget A`
- THEN feedback-seen.json 不含 A；后续 list 默认含 A
