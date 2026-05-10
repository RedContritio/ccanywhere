## MODIFIED Requirements

### Requirement: 配置文件路径

服务端 MUST 按以下顺序解析配置文件路径：

1. CLI 参数 `--config <path>`（也接受 `-c` 与 `--config=<path>` 形式），
   若提供，**绝对路径优先**；相对路径相对当前工作目录。
2. 环境变量 `$CCANYWHERE_CONFIG`，若已设置。
3. `${XDG_CONFIG_HOME:-$HOME/.config}/ccanywhere/config.json`。

CLI subcommand `serve` / `approve` / `devices` / `revoke` 都接受 `--config`，
其它都共用同一份配置文件路径。Staging 实例（同 host 不同 port 跑多份）
MUST 通过 `--config` 指向自己专用的 `config.json`——配置文件所在目录会
自动成为实例状态目录（详见"实例状态目录"），无需额外环境变量。

#### Scenario: 环境变量优先于默认路径

- GIVEN 设置了 `CCANYWHERE_CONFIG=/tmp/x.json`
- WHEN  服务端启动
- THEN  读 `/tmp/x.json`，忽略 `~/.config/ccanywhere/config.json`

#### Scenario: 配置文件缺失

- GIVEN CLI 参数 / 环境变量 / 默认路径都不指向已有文件
- WHEN  服务端启动
- THEN  MUST 以 fatal 日志退出，日志中包含解析得到的路径
- AND   退出码 MUST 为 `2`

#### Scenario: --config 指向 staging config 文件，state 自动落同目录

- GIVEN `ccanywhere serve --config /Users/me/.config/ccanywhere-staging/config.json`
- AND   该 config.json 内 **不含** `configDir` 字段
- WHEN  服务端启动
- THEN  cli-token / devices.json / projects-state.json / feedback/ 全部
        落到 `/Users/me/.config/ccanywhere-staging/`（config 文件所在目录）

### Requirement: 配置 schema

配置文件 MUST 是符合下表的合法 JSON：

| 字段                     | 类型                                  | 默认值        | 备注 |
|--------------------------|---------------------------------------|---------------|------|
| `port`                   | 1..65535 的整数                       | `62275`       | 监听端口 |
| `bindHost`               | string                                | `"127.0.0.1"` | 绑定地址 |
| `claudeBin`              | string                                | `"claude"`    | cc 二进制路径或 PATH 内名称 |
| `scrollbackBytes`        | ≥ 65536 的整数                        | `1048576`     | 单 session scrollback 上限 |
| `projectsRoot`           | string                                | （必填）      | 项目集合根目录的绝对路径 |
| `webOrigin`              | URL                                   | （必填）      | web SPA 实际服务的 origin |
| `deletedSessionTtlMs`    | ≥ 60000 的整数                        | `600000`      | 软删除 session 在 manager 中保留时长 |
| `wsHeartbeat`            | `{ intervalMs, timeoutMs }`           | 见下          | WS 帧级心跳参数 |
| `outputFps`              | 1..240 的整数                         | `60`          | 输出微聚合上限帧率 |
| `cookieName`             | 非空 string                           | `"ccanywhere_session"` | session cookie 名。仅在同一 domain 跑多个 ccanywhere 实例（如 prod + staging 不同 port）时 override |
| `configDir`              | 可选 string                           | (config 文件所在目录) | 该实例的 per-instance 状态目录（cli-token / devices.json / projects-state.json / feedback/）。缺省时取 config 文件所在目录；显式设置时绝对路径直用，相对路径相对 config 文件目录解析 |

#### Scenario: cookieName 默认值不变保持向后兼容

- GIVEN 配置不含 `cookieName` 字段
- WHEN  服务端启动
- THEN  使用 `"ccanywhere_session"` 作 cookie name（与历史 prod 行为一致）

#### Scenario: 自定义 cookieName 用于 staging 实例

- GIVEN 配置 `"cookieName": "ccanywhere_session_e2e"`
- WHEN  服务端启动并触发 register-complete / login-complete
- THEN  Set-Cookie 头使用 `ccanywhere_session_e2e=<sessionId>`
- AND   带 `Cookie: ccanywhere_session=<id>`（默认名）的请求 MUST 401
- AND   带 `Cookie: ccanywhere_session_e2e=<id>` 的请求 MUST 通过鉴权

## ADDED Requirements

### Requirement: 实例状态目录

ccanywhere 的 per-instance 状态文件（cli-token、devices.json、
projects-state.json、feedback/ 子目录）MUST 全部位于同一根目录下，
该根目录通过 `resolveConfigDir(config, configPath)` 解析：

1. 若 config 含 `configDir` 字段（非空 string），使用之；相对路径相对
   `dirname(configPath)`，绝对路径直接使用。
2. 否则使用 `dirname(configPath)`（config 文件所在目录）。

设计理由：每份 config 文件 self-contained 描述一个完整实例——dropping
一份 config.json 进新目录就足以起一个隔离的 instance。CLI 参数
`--config` 是唯一入口；不再需要 `$CCANYWHERE_CONFIG_DIR` 之类的 out-of-band
环境变量。

单 host 跑多个 ccanywhere 实例时（典型：prod + staging 不同 port），各自
launch agent 用不同的 `--config` 指向不同 config 文件，state 自然隔离：

- prod plist `--config ~/.config/ccanywhere/config.json` →
  state 在 `~/.config/ccanywhere/`
- staging plist `--config ~/.config/ccanywhere-staging/config.json` →
  state 在 `~/.config/ccanywhere-staging/`

证书目录 `~/.config/ccanywhere/certs/` 由 acme.sh 管理，是部署阶段产物，
**不**在本要求覆盖范围内（prod / staging 共享同一域名同一证书）。

#### Scenario: 默认 configDir 取 config 文件所在目录

- GIVEN `--config /home/me/.config/ccanywhere/config.json`，config 内不含
        `configDir` 字段
- WHEN  服务端调 `resolveConfigDir(config, configPath)`
- THEN  返回 `/home/me/.config/ccanywhere`

#### Scenario: 显式 configDir 字段覆盖默认

- GIVEN `--config /etc/ccanywhere/config.json`，config 内
        `"configDir": "/var/lib/ccanywhere-staging"`
- WHEN  服务端启动
- THEN  cli-token 写到 `/var/lib/ccanywhere-staging/cli-token`，
        devices.json / projects-state.json / feedback/ 同位置

#### Scenario: 相对 configDir 相对 config 文件所在目录解析

- GIVEN config 文件在 `/Users/me/repos/ccanywhere/config.json`
- AND   config 内 `"configDir": "../state"`
- WHEN  服务端调 `resolveConfigDir(config, configPath)`
- THEN  返回 `/Users/me/repos/state`
