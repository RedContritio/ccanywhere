## MODIFIED Requirements

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
| `deletedSessionTtlMs`    | ≥ 60000 的整数                        | `600000`      | 软删除 session 在 manager 中保留时长 |
| `wsHeartbeat`            | `{ intervalMs, timeoutMs }`           | 见原表        | WS 帧级心跳参数 |

`wsHeartbeat.intervalMs` 默认 `30000`，最小 `1000`。
`wsHeartbeat.timeoutMs` 默认 `60000`，必须严格大于 `intervalMs`。

每个 `tokens[i].token` MUST 至少 16 字符。每个 `projects[i].id` MUST 匹配
`/^[a-z0-9][a-z0-9-]*$/`。

(Previously: `port` 默认值 `7878`，无随机选择说明。)

服务端代码 MUST NOT 在运行时承担端口选择、frpc 配置生成、frpc 子进程管理
等职责。frp 部署相关的资料以 `examples/` 下的模板文件提供，由用户复制配置。
