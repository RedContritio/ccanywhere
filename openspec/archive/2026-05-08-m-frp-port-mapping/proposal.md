# Proposal: M-frp — 静态随机默认端口 + frpc.toml 模板

## Intent

ccanywhere 通过 frp 暴露给公网。直接让所有部署默认监听同一端口（比如 7878）
意味着扫描器一抓一个准。但服务自身不该承担"启动期挑端口"的职责——那会引入
state 文件、retry 逻辑、生命周期歧义。

折中：在 repo 出货前**一次性**用程序方式从 `[62000, 63000)` 随机选一个
端口（已选定 **`62275`**），把它落到两处静态位置：

- `src/config/schema.ts` 的 `port` 默认值。
- `examples/frpc.toml`（与 `examples/config.json` 端口对齐的部署模板）。

服务代码逻辑零变化——`fastify.listen(host, config.port)` 这一行从 M3 起就在那里。
用户复制 `examples/frpc.toml` 到自己的 frpc 路径，改 `serverAddr` / `authToken`
即可启动。多机部署若有冲突，用户在自己 config 里改 `port`，跟着改 frpc.toml；
服务不掺和。

## Scope

包含：

- `src/config/schema.ts` 的 `port` 默认值从 `7878` → `62275`。
- 新增 `examples/frpc.toml`：完整 frpc 配置模板，`localPort` / `remotePort`
  都写 `62275`，`serverAddr` / `authToken` 用占位符。
- 新增 `examples/config.json`：ccanywhere config 最小示例（含 port、token、
  project 各一）。
- 现有的 9 个 loader 测试与 server 测试中显式写 `port: 7878` 的地方更新为
  与新默认或测试本地常量一致；测试不依赖具体数字。

不包含：

- 服务代码任何关于 frp 的运行时逻辑。
- state 文件、port retry、frpc.toml 自动生成、frpc 子进程 spawn——以上
  全部不做。
- `frp` capability、新 spec 文件——这只是 repo 出货端口的默认值改动 +
  例子文件，不构成新能力。

## 用户操作面

| 场景 | 操作 |
|------|------|
| 首次部署 | 复制 `examples/config.json` 到 `~/.config/ccanywhere/config.json`，复制 `examples/frpc.toml` 到 frpc 配置路径，填 frps 地址/token，分别启动 ccanywhere 和 frpc |
| 想换端口 | 在自己的 config.json 改 `port`，frpc.toml 同步改 `localPort` 与 `remotePort`，重启两边 |
| 多机同名部署 | 同上——服务端不去重，用户自负 |

## 端口选定记录

`62275` 由 `$((62000 + $RANDOM % 1000))` 在工作会话中生成，本提案归档时
固化为 repo 默认值。后续修改或重选必须走新的 change proposal。
