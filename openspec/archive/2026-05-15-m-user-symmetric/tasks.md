# Tasks

## 段 0：保留已写代码（前置 isolation patch）

- [x] T0.1 `src/server/routes/projects.ts` 改 `resolveStore(req.user)`（已写）
- [x] T0.2 `src/server/server.ts` 引入 `resolveProjectStore` 工厂 + 缓存（已写，需扩展为 reframe 完整版）
- [x] T0.3 `src/server/server.multi-user.test.ts` 加 cross-user projects 隔离 4 测试（已写）

## 段 0.5：kind enum 重命名 `'limited'` → `'user'`（鉴权 100% 保留）

- [ ] T0.5.1 `src/users/types.ts`：`UserKind = 'owner' | 'user'`；docstring 中 "limited user" → "user"
- [ ] T0.5.2 `src/users/store.ts`：所有 `'limited'` 字面值 → `'user'`；错误消息 "limited user must..." → "user must..."；`createLimitedUser` 重命名为 `createUser`（含 input type `CreateLimitedUserInput` → `CreateUserInput`）
- [ ] T0.5.3 `src/users/store.ts` load 阶段：遇到 record `kind === 'limited'` → in-memory 改 `'user'`；若发生 migrate 触发一次 `persist()`；不抛 schema 错（lenient parse + write back）
- [ ] T0.5.4 `src/users/store.test.ts`：旧 'limited' record 启动后 migrate + persist 测试（写入 fixture .users.json 含 kind=limited，构造 store 后断言内存里是 'user' 且文件被改写）
- [ ] T0.5.5 `src/cli/user.ts` UserRecord type kind enum 改；cli help / output 文案 "limited" → "user"
- [ ] T0.5.6 `src/server/auth.ts`、`src/server/routes/auth.ts`、`src/server/routes/auth-multi-user.ts`、`src/server/routes/hook.ts`、`src/server/routes/projects.ts`、`src/server/server.ts`、`src/devices/types.ts`、`src/quota/path.ts`、`src/config/schema.ts` 中所有 `'limited'` 字面值与 "limited user" 文案 → `'user'`
- [ ] T0.5.7 test helpers：`createLimitedUserWithToken` → `createUserWithToken`；`LimitedUserWithToken` → `UserWithToken`；`CreateLimitedUserOpts` → `CreateUserOpts`
- [ ] T0.5.8 typecheck 验签名一致

## 段 1：Config schema 重塑

- [ ] T1.1 `src/config/schema.ts`：删 `projectsRoot` + `guestProjectsRoot`；加 `workspace` + `users.<name>.workspace`
- [ ] T1.2 superRefine 校验：override 绝对路径、互不嵌套、与默认子目录不重叠
- [ ] T1.3 `src/config/schema.test.ts`：workspace 默认解析 / owner override / 路径冲突拒绝 / nesting 拒绝
- [ ] T1.4 `src/cli/serve.ts`：`ensureProjectsRoot(workspace)` + 若 owner override 配了再 `ensureProjectsRoot(owner-root)`；删 `guestProjectsRoot` 处理
- [ ] T1.5 启动时 owner 未配 override 发中性警告 log

## 段 2：UserStore 重写

- [ ] T2.1 `src/users/store.ts`：`projectsRootFor(user, config)` 重写（先查 override 否则 `<workspace>/<username>`）；ctor 删 `guestProjectsRoot` 参数（改读 config 或 caller 传 workspace）
- [ ] T2.2 `createUser`（已 §0.5 改名）内 mkdir 路径改用新 helper
- [ ] T2.3 `src/users/store.test.ts`：override / 默认 / 嵌套校验
- [ ] T2.4 调用方扫一遍：`projectsRootFor` 现签名变化（含 buildServer / sessions cwd guard / setupProjects fixture）

## 段 3：DeviceStore 对称化

- [ ] T3.1 `src/devices/store.ts`：删 ctor `ownerId` 参数；`device.userId` 必填字段
- [ ] T3.2 启动 lazy backfill：load 时缺 `userId` 的 record 填 owner.id 并 persist 一次
- [ ] T3.3 `src/devices/store.test.ts`：backfill 测试 + userId 必填新建测试
- [ ] T3.4 调用方扫一遍：`new DeviceStore({...})` 不再传 ownerId

## 段 4：Auth policy 显式化

- [ ] T4.1 `src/server/routes/auth.ts` webauthn pair-init 路径加 `req.user.kind === 'owner'` policy assert（403 mask）
- [ ] T4.2 `src/server/routes/auth.ts` webauthn login-init / login-complete 去 owner-only 隐式约束（任意有 device 的 user 可登）
- [ ] T4.3 `src/server/routes/auth-multi-user.ts` 删 token 路由对 kind 的 hardcode 检查（reframe 后任意 user 可走 token 登，包含 owner）
- [ ] T4.4 测试：user pair-init → 403；owner token 登 → 200
- [ ] T4.5 `openspec/specs/auth/spec.md` policy 描述更新

## 段 5：Routes 统一 resolveStore

- [ ] T5.1 `src/server/routes/sessions.ts`：`projectStore.get(body.projectId)` → `resolveStore(req.user).get(...)`；保留 `isWithinSubtree` 作 defense-in-depth
- [ ] T5.2 `src/server/routes/sessions-resume.ts`：`projectStore.get(stub.info.projectId)` → `resolveStore(req.user).get(...)`
- [ ] T5.3 `src/server/routes/share.ts`：`projectStore.get(row.info.projectId)` → `resolveStore(req.user).get(...)`
- [ ] T5.4 `src/server/server.ts`：`resolveProjectStore` 传给 4 个 register*Routes 调用
- [ ] T5.5 base store 构造改读 `config.users.owner.workspace ?? <workspace>/owner`

## 段 6：测试覆盖

- [ ] T6.1 `src/server/server.multi-user.test.ts` 扩：user POST /api/sessions 在自己项目 → 201（不 project_not_found）
- [ ] T6.2 user POST /api/sessions 拿 owner project id → 404（resolveStore 找不到）
- [ ] T6.3 user POST /api/sessions/:id/resume 自己 dead stub → 201
- [ ] T6.4 user POST /api/share 自己 session → 201；拿 owner session → 404
- [ ] T6.5 owner token 登 + GET /api/projects → 仍能看 owner 项目
- [ ] T6.6 user webauthn pair-init → 403

## 段 7：Test helpers / fixtures 适配

- [ ] T7.1 `src/server/server.test-helpers.ts`：baseConfig 用 `workspace` 字段；setupProjects 把 owner 项目放在 owner override 下；setup 注入工厂
- [ ] T7.2 全 test 跑通（typecheck + 380+ 现有测试不破）

## 段 8：Spec delta

- [ ] T8.1 `openspec/specs/config/spec.md` 重写（projectsRoot/guestProjectsRoot → workspace + users override）
- [ ] T8.2 `openspec/specs/auth/spec.md` policy 段更新
- [ ] T8.3 `openspec/specs/rest-api/spec.md` projects 4 段（user-aware）+ sessions/share 段
- [ ] T8.4 `openspec/specs/rest-api/multi-user.spec.md` `POST /api/auth/token` 接受任意 user
- [ ] T8.5 `docs/deployment.md` workspace 字段说明 + owner override 示例

## 段 9：Build & Deploy

- [ ] T9.1 typecheck:all + lint + lint:md + test 全绿
- [ ] T9.2 build:all
- [ ] T9.3 请用户授权改 `~/.config/ccanywhere/config.json`：删 `projectsRoot` + `guestProjectsRoot`，加 `workspace` + `users.owner.workspace`
- [ ] T9.4 mkdir `~/ccanywhere-workspace/` (mode 0o700)；rm -rf `~/Projects-guests/`（确认仅含空 `e2e/`）
- [ ] T9.5 launchctl kickstart -k；healthz 200 验
- [ ] T9.6 server.log 检查：owner-override 警告应不出现（已配 override）；users.json 自动 migrate 'limited' → 'user' 已发生（log + 文件 diff 验证）；现有 owner webauthn cookie 仍可用

## 段 10：Dogfood 复验 + 接续 quota

- [ ] T10.1 owner 浏览器（webauthn 设备）hard refresh：cookie 仍 valid，不被强制重登；GET /api/projects 仍能看到 owner 现有项目
- [ ] T10.2 e2e（旧 limited，已 migrate kind=user）浏览器 hard refresh：token cookie 仍 valid；看不到 owner 项目；自己创建项目落 `~/ccanywhere-workspace/e2e/<name>/`；新建对话 201（不再 project_not_found）
- [ ] T10.3 e2e 起 cc session 跑 ≥2 轮 prompt，第二轮触发 tokens=1000 quota block

## 段 11：Commit + Archive

- [ ] T11.1 commit（含 archive 路径 + spec delta 摘要）
- [ ] T11.2 mv openspec/changes/m-user-symmetric → openspec/archive/<date>-m-user-symmetric
