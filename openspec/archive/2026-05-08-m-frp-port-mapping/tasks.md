# Tasks

## 1. config schema 默认值

- [ ] 1.1 `src/config/schema.ts` 的 `ConfigSchema.port.default(7878)` 改为 `.default(62275)`
- [ ] 1.2 `src/config/loader.test.ts` 中检查默认 port 的断言改为 `62275`

## 2. 例子文件

- [ ] 2.1 新增 `examples/config.json`：含 `port: 62275`、占位 `tokens` 与 `projects`
- [ ] 2.2 新增 `examples/frpc.toml`：含 `serverAddr` / `authToken` 占位、`[[proxies]]` 段 `localPort = remotePort = 62275`、文件头注释说明端口与 ccanywhere config.port 对齐
- [ ] 2.3 README 或 docs（如已存在）追加 quickstart 链接（M8 范围；本提案先把示例落地）

## 3. spec 归档

- [ ] 3.1 `pnpm typecheck && pnpm test` 全过
- [ ] 3.2 把 `changes/m-frp-port-mapping/specs/config/spec.md` 的 delta 合并进 `openspec/specs/config/spec.md`（仅默认值描述变化）
- [ ] 3.3 移到 `archive/YYYY-MM-DD-m-frp-port-mapping/`
- [ ] 3.4 commit "M-frp: pin default port to 62275 + frpc.toml example"

## Commits

- (no matching commits found in git log)
