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
| `tokens`                 | `{ label, token, ... }` 数组          | （必填，≥1）  | 用户 token 列表 |
| `projects`               | `{ id, name, cwd }` 数组              | （必填，≥1）  | cc cwd 白名单 |
| `deletedSessionTtlMs`    | ≥ 60000 的整数                        | `600000`      | 软删除 session 在 manager 中保留时长（10 分钟，覆盖弱网络重试窗口） |
| `wsHeartbeat`            | `{ intervalMs, timeoutMs }`           | 见下          | WS 帧级心跳参数 |

`wsHeartbeat.intervalMs` 默认 `30000`，最小 `1000`。
`wsHeartbeat.timeoutMs` 默认 `60000`，必须严格大于 `intervalMs`。

每个 `tokens[i].token` MUST 至少 16 字符。每个 `projects[i].id` MUST 匹配
`/^[a-z0-9][a-z0-9-]*$/`。

服务端代码 MUST NOT 在运行时承担端口选择、frpc 配置生成、frpc 子进程管理
等职责。frp 部署相关的资料以 `examples/` 下的模板文件提供，由用户复制配置。

#### Scenario: 空 tokens 数组被拒绝

- GIVEN 配置中 `"tokens": []`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `tokens`，退出码 `2`

#### Scenario: 空 projects 数组被拒绝

- GIVEN 配置中 `"projects": []`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `projects`，退出码 `2`

#### Scenario: 短 token 被拒绝

- GIVEN token 字符串长度小于 16
- WHEN  服务端启动
- THEN  MUST 退出，退出码 `2`

#### Scenario: 非 kebab-case 项目 id 被拒绝

- GIVEN `projects[0].id = "BadId"`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 "kebab-case"，退出码 `2`

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

### Requirement: 重复检测

加载器 MUST 拒绝包含重复 `projects[*].id` 或重复 `tokens[*].token` 的配置。

#### Scenario: 重复项目 id

- GIVEN 两个 project 条目共用 `id: "demo"`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息含 "duplicate project id"，退出码 `2`

#### Scenario: 重复 token 值

- GIVEN 两个 token 条目共用同一个 `token` 字符串
- WHEN  服务端启动
- THEN  MUST 退出，错误信息含 "duplicate token"，退出码 `2`
