# Tasks: M-staging-env

## 实施

- [x] T1. `src/config/schema.ts` 加 `cookieName` 必填默认 `'ccanywhere_
  session'` + `configDir` 可选 string
- [x] T2. `src/config/paths.ts` 新建 export `resolveConfigDir(config,
  configPath)`：config.configDir 优先（绝对直用 / 相对相对 config 文件
  目录），缺省 fallback dirname(configPath)
- [x] T3. `src/cli.ts` 加全局 `--config <path>`（`-c` / `--config=<path>`
  也接受）parse + 透传给 serve / approve / devices / revoke
- [x] T4. `src/cli/serve.ts` `runServe(configPath?)` 用 resolveConfigDir
  算出 configDir 注入 buildServer + ensureCliToken / projects-state /
  devices store 都用该 dir
- [x] T5. `src/cli/internal-client.ts` `loadInternalClientConfig(configPath?)`
  + `makeInternalClient(configPathOrCfg?)` 接 configPath
- [x] T6. `src/cli/approve.ts` / `devices.ts` / `revoke.ts` 各加
  `configPath?` 参数透传给 makeInternalClient
- [x] T7. `src/server/auth.ts` `RegisterAuthOptions.cookieName?: string` +
  hookEarlyAuth cookie 读取用 opts.cookieName ?? SESSION_COOKIE_NAME
- [x] T8. `src/server/routes/auth.ts` `AuthRoutesOptions.cookieName?:
  string` + 函数内 const cookieName 解析；所有 set/clear/read 用 cookieName
- [x] T9. `src/server/server.ts` `BuildServerOptions.configDir?` + 透传
  config.cookieName 给 registerAuth / registerAuthRoutes；configDir 给
  registerFeedbackRoutes
- [x] T10. `src/server/routes/feedback.ts` `FeedbackRoutesDeps.configDir?`
  + `feedbackDir(configDir)` 接 inject

## 测试

- [x] T11. `src/config/paths.test.ts` 新建 4 case：
  - 默认 dirname fallback
  - 绝对 configDir 直用
  - 相对 configDir 相对 config 文件目录
  - 空 string configDir 视为 unset
- [x] T12. `src/server/server.test.ts` 加 'honors config.cookieName
  override (multi-instance same-domain isolation)'
- [x] T13. 现有 fixtures (server / ws / feedback test) baseConfig
  literal 加 cookieName 字段

## 验证

- [x] T14. pnpm tsc --noEmit 干净
- [x] T15. pnpm vitest run 全绿（旧 182 + 新 5 = 187）

## Spec delta

- [x] T16. `specs/config/spec.md` 改：
  - "配置文件路径" 加 `--config` CLI 参数为最高优先级 + scenario
  - "配置 schema" 表加 cookieName / configDir 两字段
  - 新增 Requirement "实例状态目录" + 3 scenarios（默认 dirname / 绝对 /
    相对）

## 文档

- [x] T17. `docs/deployment.md` 加 §9 Staging 实例：staging config 模板
  + plist ProgramArguments 加 `--config` + frpc tunnel + 验证命令

## 部署（user 操作，不进代码）

- [ ] U1. `~/.config/ccanywhere-staging/config.json` 写入 staging config
  （port / projectsRoot / webOrigin / cookieName 四项与 prod 不同；configDir
  字段缺省 → 自动取 config 文件所在目录 = `~/.config/ccanywhere-staging/`）
- [ ] U2. `~/Library/LaunchAgents/com.<you>.ccanywhere-staging.plist`
  复制 prod plist，改 Label / log path / ProgramArguments 加
  `--config /Users/<you>/.config/ccanywhere-staging/config.json`
- [ ] U3. `frpc.toml` 加 staging tunnel + remotePort=7443
- [ ] U4. `launchctl bootstrap` staging plist；`launchctl kickstart -k`
  reload frpc
- [ ] U5. 浏览器访问 https://cc.recoco.xyz:7443 走一次 webauthn pair（无
  e2e 时人工；e2e 时 #32 globalSetup 通过 CDP 自动）

## 归档

- [ ] T18. 用户确认 commit 后 `mv changes/m-staging-env archive/<date>-
  m-staging-env`
- [ ] T19. commit
