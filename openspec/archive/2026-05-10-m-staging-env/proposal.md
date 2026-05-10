# Proposal: M-staging-env — 同 host 多实例的 staging 部署支持

## Intent

为 e2e 测试（#32 backbone）与 dogfood-staging 提供一个完全隔离但走真实
部署链路（HTTPS / frpc / launchctl）的 ccanywhere 实例。约束：

- prod / staging 同 host 同 domain 不同 port（避免改 DNS / 加 wildcard 证书）
- staging 数据完全隔离：cli-token / devices / projects / feedback / cc
  history 都不串扰 prod
- prod 安全表面 0 扩张：无 backdoor route、无 dev-only 标志位
- ccanywhere 代码侵入最小：仅暴露 env-driven 配置点

## 设计要点

### cookieName 配置项

RFC 6265 cookie 忽略 port——同 host 同 cookie name，浏览器对 Set-Cookie
last-write-wins。如果 staging 复用 prod 的 `ccanywhere_session` cookie name，
staging 任何 set-cookie 都会踢掉用户的 prod 会话。

config schema 加 `cookieName` 字段：

- prod 默认 `'ccanywhere_session'`（向后兼容）
- staging override `'ccanywhere_session_e2e'` 或同义独特值
- 浏览器同时持两份 cookie，互不覆盖

### --config CLI 参数 + config.configDir 字段

ccanywhere 的 per-instance 状态文件（cli-token / devices.json /
projects-state.json / feedback/）原硬编码到 `~/.config/ccanywhere/`。
改为：

- CLI 加全局参数 `--config <path>`（也接受 `-c` 与 `--config=<path>`），
  贯穿 serve / approve / devices / revoke。无 `--config` 时走原默认
  路径链（`$CCANYWHERE_CONFIG` / `$XDG_CONFIG_HOME` / `~/.config`）。
- config schema 加可选字段 `configDir?: string`，缺省时取 config 文件
  所在目录（`dirname(configPath)`），显式设置时绝对路径直用、相对路径
  相对 config 文件目录解析。
- 抽出 `resolveConfigDir(config, configPath)` helper，cli-token /
  devices / projects-state / feedback 都通过它解析路径。

每份 config 文件 self-contained 描述一个完整实例 —— dropping config.json
进新目录就足以起一个隔离 instance。**不引入新环境变量**（这一点比
最初设想的 `$CCANYWHERE_CONFIG_DIR` 干净：CLI 参数是 explicit、user 一
眼能看到 launch agent plist 的 ProgramArguments）。

Staging launch agent ProgramArguments：

```
node /path/to/ccanywhere/dist/cli.js --config /Users/<you>/.config/ccanywhere-staging/config.json
```

state 文件自动落到 `~/.config/ccanywhere-staging/`。

### 数据隔离全景

| 文件 | prod 路径 | staging 路径（设 CONFIG_DIR 后自动）|
|---|---|---|
| config.json | `~/.config/ccanywhere/config.json` | `$CONFIG_DIR/config.json` |
| cli-token | `~/.config/ccanywhere/cli-token` | `$CONFIG_DIR/cli-token` |
| devices.json | `~/.config/ccanywhere/devices.json` | `$CONFIG_DIR/devices.json` |
| projects-state.json | `~/.config/ccanywhere/projects-state.json` | `$CONFIG_DIR/projects-state.json` |
| feedback/ | `~/.config/ccanywhere/feedback/` | `$CONFIG_DIR/feedback/` |
| projectsRoot（cwd）| config 里写的路径 | staging config.json 里另写一个 |
| cc history (`~/.claude/projects/<encoded-cwd>/...`) | encoded from prod cwd | encoded from staging cwd（自动隔离）|
| 证书 `~/.config/ccanywhere/certs/` | 共享 | 共享（同 domain 同 cert，acme.sh 管理）|

最后两条说明：cc 自己的 history file 路径由 cwd 推导，staging 的 cwd
不同 → encoded path 不同 → cc 写入完全独立的 jsonl 文件，**不污染日常 cc
历史**。证书由 acme.sh 在部署阶段管理，prod / staging 共享同一文件，无需
单独考虑。

### 部署侧（不进 git，docs 提供）

`docs/deployment.md` 加 §9 staging 实例 section：

- staging config.json 模板（4 个差异字段：port / projectsRoot / webOrigin
  含 :7443 / cookieName）
- staging launch agent plist（Label / log path / ProgramArguments 加 `--config <staging-config-path>`）
- frpc.toml 加 staging tunnel + remotePort=7443
- 验证隔离命令

### 与其它 task 的关联

- 与 #32 M-e2e-mobile-logic（重命名为 e2e-backbone）：staging 起来后 e2e
  globalSetup 直接打 staging URL，CDP virtual authenticator 自动 pair，
  cliToken 从 `$CONFIG_DIR/cli-token` 读自动 approve pending pair。
- 与 #36 M-ws-deleted-session-ux：chip 文字 e2e spec 覆盖在 #32 backbone
  之上。
- 与 #40 M-auth-expiry：staging 的 device 可设短 ttl（30 分钟）减少
  cookie 长期持有的安全风险。

## Scope

### server-side 代码（已实施）

- `src/config/schema.ts` 加 `cookieName` + `configDir` 两字段
- `src/config/paths.ts`（new）export `resolveConfigDir(config, configPath)`
  helper：config.configDir 优先（绝对直用 / 相对相对 config 文件目录），
  缺省 fallback dirname(configPath)
- `src/cli.ts` 加全局 `--config <path>`（也支持 `-c` / `--config=<path>`）
  parse + 透传给所有 subcommand
- `src/cli/serve.ts` `runServe(configPath?)` 用 resolveConfigDir 算出
  configDir 注入 buildServer
- `src/cli/internal-client.ts` `loadInternalClientConfig(configPath?)` /
  `makeInternalClient(configPathOrCfg?)` 接 configPath
- `src/cli/approve.ts` / `devices.ts` / `revoke.ts` 透传 configPath
- `src/server/auth.ts` `RegisterAuthOptions` 加 `cookieName?`
- `src/server/routes/auth.ts` `AuthRoutesOptions` 加 `cookieName?`，所有
  set/clear/read cookie 处用 opts.cookieName ?? SESSION_COOKIE_NAME
- `src/server/server.ts` `BuildServerOptions` 加 `configDir?`；feedback
  route 注入 configDir，registerAuth/registerAuthRoutes 透传 cookieName
- `src/server/routes/feedback.ts` `FeedbackRoutesDeps` 加 `configDir?`，
  `feedbackDir(configDir)` 接 inject

### 测试

- `src/config/paths.test.ts`（new）4 case：默认 dirname / 绝对 configDir /
  相对 configDir / 空 string fallback
- `src/server/server.test.ts` 加 case "honors config.cookieName override"
- 现有 fixture 加 cookieName 字段（feedback.test / server.test / ws/server.test）

### 文档

- `docs/deployment.md` §9 staging 实例（部署 walkthrough，--config 形式）

### spec delta（已合并到 specs/）

- `specs/config/spec.md`：
  - "配置文件路径" 加 `--config` CLI 参数解析顺序 + scenario
  - "配置 schema" 表加 `cookieName` + `configDir` 字段
  - 新加 "实例状态目录" Requirement + 3 scenarios（默认 / 绝对 / 相对）

## Out of scope

- e2e backbone 本身（→ #32）
- staging 实例的实际启动 / launch agent bootstrap / frpc reload（部署
  操作，user 按 docs/deployment.md §9 手动跑一次）
- 部署自动化脚本（暂不做；examples 里手动模板已够）

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| prod 默认行为 0 改变 | cookieName 默认 `'ccanywhere_session'`；configDir 缺省取 dirname(configPath)；未传 `--config` 时走原默认 path 链 |
| staging cookie 不踢 prod 会话 | cookieName 不同，浏览器 Set-Cookie 互不覆盖 |
| staging state 不污染 prod | `resolveConfigDir(config, configPath)` 单一入口，所有 per-instance 状态文件都通过它解析 |
| cc history 自动隔离 | cc 自己用 cwd encoded path，staging cwd 不同 → encoded 不同（无需 ccanywhere 显式干预）|
| prod 安全表面不扩张 | 无新 HTTP route / 无新 backdoor flag / 无 dev-only 模式 |
