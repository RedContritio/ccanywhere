# Config

## Purpose

ccanywhere 启动时读一个 JSON 配置文件，里面包含运行所需的全部信息：监听地址、
谁可以认证、哪些本地项目目录可以暴露为 cc session。配置错误必须在启动时显式失败，
绝不允许等到第一个请求才暴露。

## Requirements

### Requirement: 配置文件路径

服务端 MUST 按以下顺序解析配置文件路径：

1. 环境变量 `$CCANYWHERE_CONFIG`（绝对或相对路径），若已设置。
2. `${XDG_CONFIG_HOME:-$HOME/.config}/ccanywhere/config.json`。

#### Scenario: 环境变量优先于默认路径

- GIVEN 设置了 `CCANYWHERE_CONFIG=/tmp/x.json`
- WHEN  服务端启动
- THEN  读 `/tmp/x.json`，忽略 `~/.config/ccanywhere/config.json`

#### Scenario: 配置文件缺失

- GIVEN 环境变量与默认路径都不指向已有文件
- WHEN  服务端启动
- THEN  MUST 以 fatal 日志退出，日志中包含解析得到的路径
- AND   退出码 MUST 为 `2`

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

