## MODIFIED Requirements

### Requirement: 配置 schema

配置文件 MUST 是符合下表的合法 JSON：

| 字段                     | 类型                                  | 默认值        | 备注 |
|--------------------------|---------------------------------------|---------------|------|
| `port`                   | 1..65535 的整数                       | `7878`        | 监听端口 |
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

(Previously: 表中无 `deletedSessionTtlMs` 与 `wsHeartbeat` 两行。)

#### Scenario: deletedSessionTtlMs 太小被拒绝

- GIVEN 配置中 `deletedSessionTtlMs: 30000`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息提及 `deletedSessionTtlMs`，退出码 `2`

#### Scenario: wsHeartbeat 顺序错误被拒绝

- GIVEN 配置中 `wsHeartbeat: { intervalMs: 60000, timeoutMs: 30000 }`
- WHEN  服务端启动
- THEN  MUST 退出，错误信息说明 `timeoutMs` 必须大于 `intervalMs`，退出码 `2`
