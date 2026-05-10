# Config

## Purpose

ccanywhere 启动时读一个 JSON 配置文件，里面包含运行所需的全部信息：监听地址、
谁可以认证、哪些本地项目目录可以暴露为 cc session。配置错误必须在启动时显式失败，
绝不允许等到第一个请求才暴露。

## Requirements

### Requirement: guestProjectsRoot（m-multi-user）

配置 MUST 含必填字段 `guestProjectsRoot: string`，为 limited user 项目
沙盒的父目录。owner 用 `projectsRoot`；每个 limited user 的项目根 =
`<guestProjectsRoot>/<username (NFC)>/`。

加载校验 MUST：
- `projectsRoot` 与 `guestProjectsRoot` MUST NOT 相同。
- 两者 MUST NOT 互为父子（任一为另一前缀 + 路径分隔符 → reject）。
- server 启动时 MUST `mkdir -p guestProjectsRoot`（mode 0o700）。

#### Scenario: 不重叠校验

- GIVEN config `projectsRoot: '/a'`, `guestProjectsRoot: '/a/guests'`
- WHEN  `loadConfig`
- THEN  抛 ConfigError 含 `must not nest`

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

- GIVEN 环境变量与默认路径都不指向已有文件
- WHEN  服务端启动
- THEN  MUST 以 fatal 日志退出，日志中包含解析得到的路径
- AND   退出码 MUST 为 `2`

#### Scenario: --config 指向 staging config 文件，state 自动落同目录

- GIVEN `ccanywhere serve --config /Users/me/.config/ccanywhere-staging/config.json`
- AND   该 config.json 内 **不含** `configDir` 字段
- WHEN  服务端启动
- THEN  cli-token / devices.json / projects-state.json / feedback/ 全部
        落到 `/Users/me/.config/ccanywhere-staging/`（config 文件所在目录）

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

### Requirement: 配置 schema

配置文件 MUST 是符合下表的合法 JSON：

| 字段                     | 类型                                  | 默认值        | 备注 |
|--------------------------|---------------------------------------|---------------|------|
| `port`                   | 1..65535 的整数                       | `62275`       | 监听端口（在 `[62000, 63000)` 范围内随机选定，固化为 repo 默认；多机部署用户可自行覆盖） |
| `bindHost`               | string                                | `"127.0.0.1"` | 绑定地址 |
| `claudeBin`              | string                                | `"claude"`    | cc 二进制路径或 PATH 内名称 |
| `scrollbackBytes`        | ≥ 65536 的整数                        | `1048576`     | 单 session scrollback 上限 |
| `projectsRoot`           | string                                | （必填）      | 项目集合根目录的绝对路径；其直接子目录被自动列为可选项目 |
| `webOrigin`              | URL                                   | （必填）      | web SPA 实际服务的 origin（如 `https://ccanywhere.example.com`）。WebAuthn `rpID` 由其 hostname 派生；`expectedOrigin` 校验也用它。改变 `webOrigin` 会让所有已配对设备失效 |
| `deletedSessionTtlMs`    | ≥ 60000 的整数                        | `600000`      | 软删除 session 在 manager 中保留时长（10 分钟，覆盖弱网络重试窗口） |
| `wsHeartbeat`            | `{ intervalMs, timeoutMs }`           | 见下          | WS 帧级心跳参数 |
| `cookieName`             | 非空 string                           | `"ccanywhere_session"` | session cookie 名。仅在同一 domain 跑多个 ccanywhere 实例（如 prod + staging 不同 port）时 override —— RFC 6265 cookie 忽略 port，同 host 同 cookie name 浏览器 last-write-wins，会让 staging 的 Set-Cookie 踢掉 prod 的会话。staging 实例 MUST 设成与 prod 不同的值（如 `"ccanywhere_session_e2e"`） |
| `configDir`              | 可选 string                           | (config 文件所在目录) | 该实例的 per-instance 状态目录（cli-token / devices.json / projects-state.json / feedback/）。缺省时取 config 文件所在目录；显式设置时绝对路径直用，相对路径相对 config 文件目录解析 |

`wsHeartbeat.intervalMs` 默认 `30000`，最小 `1000`。
`wsHeartbeat.timeoutMs` 默认 `60000`，必须严格大于 `intervalMs`。

`projectsRoot` MUST 非空字符串；启动时若该路径不存在 MUST 自动 `mkdir -p`
创建，若不可读 MUST fatal 退出，若可读不可写则继续运行但记录 warn
（list/select OK，新建项目会失败）。project id MUST 等于其在
`projectsRoot` 下的目录 basename。

`webOrigin` MUST 是带 scheme 的 URL；非 https 时 cookie `Secure` 标志关掉
（仅 `http://localhost` / `http://127.0.0.1` 这类本地 dev 场景）。生产部署
MUST 使用 https，否则浏览器 WebAuthn API 拒绝调用。

服务端代码 MUST NOT 在运行时承担端口选择、frpc 配置生成、frpc 子进程管理
等职责。frp 部署相关的资料以 `examples/` 下的模板文件提供，由用户复制配置。

`cookieName` 默认值与历史一致；除非走"同 domain 跑多实例"场景，否则不要
覆盖。覆盖时 prod 与每个 staging 的 cookieName MUST 互不相同——同名会让
浏览器把后到的 Set-Cookie 写覆盖之前的，用户日常 prod 会话被踢登录页。

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

#### Scenario: 缺失 projectsRoot 被拒绝

- GIVEN 配置中没有 `projectsRoot` 字段
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `projectsRoot`，退出码 `2`

#### Scenario: projectsRoot 不存在时自动创建

- GIVEN 配置 `"projectsRoot": "/path/that/does/not/exist"`
- WHEN  服务端启动
- THEN  MUST 自动 `mkdir -p` 创建该路径，启动成功

#### Scenario: projectsRoot 不可读 fatal

- GIVEN `projectsRoot` 指向一个 chmod 0o000 的目录
- WHEN  服务端启动
- THEN  MUST 退出，错误信息含 "not readable"，退出码 `2`

#### Scenario: projectsRoot 不可写仅 warn

- GIVEN `projectsRoot` 指向一个 chmod 0o555 的目录
- WHEN  服务端启动
- THEN  服务正常启动，list/select project OK；POST `/api/projects` MUST 返回 403

#### Scenario: 缺失 webOrigin 被拒绝

- GIVEN 配置中没有 `webOrigin` 字段
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `webOrigin`，退出码 `2`

#### Scenario: webOrigin 非 URL 被拒绝

- GIVEN `"webOrigin": "not-a-url"`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `webOrigin`，退出码 `2`

#### Scenario: deletedSessionTtlMs 太小被拒绝

- GIVEN 配置中 `deletedSessionTtlMs: 30000`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `deletedSessionTtlMs`，退出码 `2`

#### Scenario: wsHeartbeat 顺序错误被拒绝

- GIVEN 配置中 `wsHeartbeat: { intervalMs: 60000, timeoutMs: 30000 }`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息说明 `timeoutMs` 必须大于 `intervalMs`，退出码 `2`

#### Scenario: outputFps 越界被拒绝

- GIVEN 配置中 `outputFps: 0` 或 `outputFps: 999`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `outputFps`，退出码 `2`

#### Scenario: outputFps 影响 ws 输出节奏

- GIVEN 配置中 `outputFps: 24`
- WHEN  服务端启动并接受 WebSocket 连接
- THEN  PTY 输出的 trailing-flush 窗口长度 MUST 约为 `Math.round(1000/24) = 42 ms`

