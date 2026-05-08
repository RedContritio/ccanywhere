# Tasks

## 1. 删除 spawn 时的 hook 注入

- [ ] 1.1 `src/session/manager.ts` 删除 spawn 内 createHookConfigDir / 注入 CLAUDE_CONFIG_DIR / on('exit') 清理 tmp dir 的逻辑
- [ ] 1.2 `Session` 接口删除 `hookConfigDir`；`SessionManager.hookConfigDirOf` 删除
- [ ] 1.3 `SpawnOptions.hookEndpoint` 字段删除
- [ ] 1.4 `src/session/hooks.ts` 保留 `buildHookSettings` 与 `HookEndpoint` 类型；删除 `createHookConfigDir` / `cleanupHookConfigDir`（不再被调用）
- [ ] 1.5 `src/session/hooks.test.ts` 清理：保留 buildHookSettings 测试，删除 create/cleanup 相关测试

## 2. 清理 hookEndpoint 透传链

- [ ] 2.1 `src/server/routes/sessions.ts` 删除 `SessionRoutesOptions.hookEndpoint` 与相关 spawn 参数装配
- [ ] 2.2 `src/server/server.ts` 删除 `BuildServerOptions.hookEndpoint`，对应 sessionOpts 装配也删
- [ ] 2.3 `src/cli.ts` 删除 hookEndpoint factory；保留 `actualPort` 仅用于启动日志
- [ ] 2.4 测试中受影响的 buildServer 调用（server.test / ws.test）相应清理

## 3. spec 修订

- [ ] 3.1 `openspec/changes/m-hook-opt-in/specs/hooks/spec.md` 描述 opt-in（user 手动配）+ buildHookSettings 模板生成器仍提供
- [ ] 3.2 `openspec/changes/m-hook-opt-in/specs/sessions/spec.md` MODIFIED：state machine 描述 busy 是 opt-in（hook 才能到达）

## 4. 验证 + 归档

- [ ] 4.1 `pnpm typecheck && pnpm test` 全过
- [ ] 4.2 e2e 复跑（healthz + login + 创建 + cc 启动后真用 user auth，不再触发登录页）
- [ ] 4.3 把 changes/m-hook-opt-in/specs/ 合并到 openspec/specs/
- [ ] 4.4 移到 archive/YYYY-MM-DD-m-hook-opt-in/
- [ ] 4.5 commit "fix(hook): drop CLAUDE_CONFIG_DIR injection so cc inherits user auth"
