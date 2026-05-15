---
status: in-flight
---

# Proposal: m-user-symmetric — User 模型 / Auth Policy / Workspace Config 全面对称化

## Intent

m-multi-user (#44, archived 2026-05-11) 把 ccanywhere 从 device-centric reframe
为 user-centric，但 owner 仍是 first-class，user 是 second-class:

- DeviceStore ctor 接 `ownerId`，`device.userId` 字段事实上始终是 owner，runtime
  assert(`user.kind === 'owner'`) 内化为数据层 invariant
- `POST /api/auth/token` 路由 hardcode `user.kind !== 'user' → 401`，owner
  无法用 token 登入
- 路由层默认拿 buildServer 注入的 owner 单例 ProjectStore：projects（已知漏，
  见 dogfood 复现）、sessions、sessions-resume、share 全部依赖单例，user
  user 视角下 4 个 endpoint 全部用 owner 数据
- config 顶级两个不对称字段 `projectsRoot`(owner) + `guestProjectsRoot`(user
  父) 强化二元模型；user 项目目录约定 `<guestProjectsRoot>/<username>/`
  无 per-user 自定义空间

dogfood quota 时 user `e2e` 登入后看到 owner Projects 实证（GET
/api/projects 用 owner 单例），且新建项目后立即"新建对话"返 `project_not_found`
（POST /api/sessions 用 owner 单例 .get() 找不到 user 项目）。

第一次 isolation patch 只补了 `projects.ts` 一面，本 reframe 把"路由默认拿
owner 单例"这一类问题从数据层根除：**所有 user 在数据层对称，policy 层显式
enforce kind 差异**。

## 决策

### 0. 命名与鉴权可用性约束（前置硬约束）

- **kind enum 重命名**：`User.kind: 'owner' | 'limited'` → `'owner' | 'user'`。
  ccanywhere 模型只有两种身份：唯一的 `owner` 与普通 `user`。`'limited'`
  字面值及其衍生（"limited user" 文案、`limited-only` 注释、`createLimitedUser`
  / `createLimitedUserWithToken` 命名等）全部消除。
- **鉴权 100% 保留**：reframe 不破坏任何已签发的 owner webauthn cookie 与
  user token cookie，**已登入设备无需重新登录**。具体保护点：
  - `DeviceStore` 改 ctor 与 `userId` 必填语义时，**不动 device.sessions
    映射**（cookie value = sessionId，存在 device.sessions 内）
  - `TokenStore.verify(plaintext)` 路径与 schema 不动；token cookie 仍走
    constant-time hash 比对
  - `UserStore` 启动 load 时遇到 `kind: 'limited'` 的旧 record，**一次性
    in-memory migrate 成 `'user'` 并 persist**；不抛 schema 错
  - prod `devices.json` 已含 `userId`（m-multi-user ship 时填过），无需二
    次迁移
  - prod `~/.config/ccanywhere/users.json` 现含一个 owner record + 一个旧
    `kind: 'limited'` 的测试 user；启动 load 后该 user migrate 成
    `kind: 'user'`，已签发的 token 仍 valid

### 1. Data 层对称化

| 实体 | 现状 | reframe 后 |
|---|---|---|
| `User.kind: 'owner' \| 'user'` | 数据层 enum 决定行为分支 | 保留，**仅作 policy hint**，不再影响 store/route 解析 |
| `DeviceStore` ctor `ownerId` | 所有 device 隐式 fallback 到 owner | 删除 ctor `ownerId` 参数；`device.userId` 必填字段；启动时 lazy backfill 老 device record（缺 userId → 填 owner.id 一次性 persist）|
| `TokenStore` | 已对称（每个 token 持 userId）| 不变 |
| `ProjectStore` 解析 | owner→`projectsRoot`，user→`<guest>/<username>/` 硬编码 | 通过 `UserStore.projectsRootFor(user, config)` 统一；具体路径走 config（见 §3）|

### 2. Policy 层（kind 唯一仍 enforce 的地方）

| 路由 | 现状 | reframe |
|---|---|---|
| `POST /api/auth/webauthn/pair-init` | 隐式 owner-only | **显式 policy**：require `req.user.kind === 'owner'`，否则 403 |
| `POST /api/auth/webauthn/login-init` | 隐式 owner-only | 任意有 device 的 user（事实上目前只 owner 有 device，policy 不 hardcode kind）|
| `POST /api/auth/token` | `user.kind !== 'user'` → 401 | **任意 user 可用 token 登入**（owner 也可签自己的 token，便于自动化）|
| `POST /api/internal/tokens` | 已对称 | 不变 |
| `POST /api/sessions` cwd guard | 用注入的 owner 单例 store + `isWithinSubtree` 检查 | 改用 `resolveStore(req.user)`，依赖 store 隔离作 first line；`isWithinSubtree` 保留作 defense-in-depth |
| `POST /api/sessions/:id/resume` 项目查找 | owner 单例 store | `resolveStore(req.user)` |
| `POST /api/share` 项目查找 | owner 单例 store | `resolveStore(req.user)` |
| hook quota check | `user.kind === 'owner'` 跳过 | 保留——policy "owner 不限额" |

### 3. Config 层对称（破坏性变更）

```jsonc
{
  "workspace": "/Users/redcontritio/ccanywhere-workspace",   // 默认 user 父目录
  "users": {
    "owner": { "workspace": "/Users/redcontritio/Projects" }   // 可选 override，绝对路径
  }
}
```

- 顶级 `workspace`: string，必填，默认 user 父目录。每个 user 默认 root =
  `<workspace>/<username>`。
- `users.<name>.workspace`: string?，可选 override，**绝对路径**（不再走父目录
  + username 拼接，便于 owner 指向已有项目仓库）。
- 顶级 `projectsRoot` + `guestProjectsRoot` **删除**（schema bump，破坏性）。
- 启动时若 owner 未配 `users.owner.workspace` 发**中性警告**：
  > owner 未配 `users.owner.workspace` — owner 项目根走默认 `<workspace>/owner`。
  > 如需指向其他目录（例如已有的项目仓库），在 config 设
  > `users.owner.workspace: "<abs path>"`。

  警告是中性的，不假设 first-time / 老用户身份；适合开源后随手 deploy 与
  保留现有项目两种场景。

#### Schema 校验（zod superRefine）

- `users.<name>.workspace` 必须绝对路径
- 任意两 user override 路径不嵌套（防 alice override 套 bob override）
- override 与 `<workspace>/<其他 user>` 路径不重叠（防 owner override 指到
  `<workspace>/owner` 但 alice override 指到 `<workspace>/owner/sub`）
- 仅 `users.owner` 当前被认可（限 ccanywhere 唯一 owner 模型）；其他 user
  override 在 v2 模型成立但无现成创建路径，schema 容忍但不要求

### 4. Routes 统一接口

`buildServer` 把 `resolveProjectStore: (user) => ProjectStore` 工厂传给 **所有**
用到 ProjectStore 的路由：projects（已 done）、sessions、sessions-resume、share。
4 个路由的 `projectStore.get()` / `.create()` / `.hide()` / `.list()` 全部改
`resolveStore(req.user).*`。

工厂内部：

- owner kind 直接返 buildServer 注入的 base store（`config.users.owner.workspace`
  或默认 `<workspace>/owner`，启动时构造）
- user / 任意非 owner user → lazy 构造 `Map<username, ProjectStore>` 缓存，
  root 由 `projectsRootFor(user, config)` 解析
- `req.user === undefined`（老 fixture / pre-multi-user）→ 退回 base store，向
  后兼容

### 5. Prod 数据迁移

- **config**：删 `projectsRoot` + `guestProjectsRoot`，加 `workspace` +
  `users.owner.workspace`（按 CLAUDE.md "Schema bump 必须同步 prod config"
  流程，ship 时主动请用户授权改 `~/.config/ccanywhere/config.json`）
- **fs**：mkdir `~/ccanywhere-workspace/`（mode 0o700）；删旧 `~/Projects-guests/`
  （仅含空 `e2e/` 目录，dogfood 副产物，无 user 数据）
- **DeviceStore**：lazy backfill 老 device record 缺 `userId` 字段 → 填
  `owner.id` 一次性 persist；不需手工干预
- **UserStore / TokenStore**：不动
- **e2e user**：user 数据在 `~/.config/ccanywhere/users.json` 不动；下次登入
  后 `<workspace>/e2e/` 由 lazy ProjectStore 构造时自动 mkdir

## 落地点

| 层 | 文件 | 改动 |
|---|---|---|
| schema | `src/config/schema.ts` | 删 `projectsRoot` + `guestProjectsRoot`；加 `workspace` + `users.<name>.workspace`；superRefine 校验 |
| schema | `src/config/paths.ts` | 如有 path 解析 helper 引用旧字段，更新 |
| user | `src/users/store.ts` | `projectsRootFor(user, config)` 重写：先查 override，否则 `<workspace>/<username>`；ctor 删 `guestProjectsRoot` 参数（改读 config）|
| device | `src/devices/store.ts` | ctor 删 `ownerId` 参数；启动 lazy backfill 缺 `userId` 的老 record |
| auth | `src/server/auth.ts` / `src/server/routes/auth.ts` | webauthn pair-init 加 `req.user.kind === 'owner'` 显式 policy；login-init 去 owner-only |
| auth | `src/server/routes/auth-multi-user.ts` | 删 `user.kind !== 'user'` 这条；任意 user 可 token 登 |
| route | `src/server/routes/projects.ts` | 已用 `resolveStore` |
| route | `src/server/routes/sessions.ts` | `projectStore.get(body.projectId)` → `resolveStore(req.user).get(...)`；保留 cwd `isWithinSubtree` |
| route | `src/server/routes/sessions-resume.ts` | 同 |
| route | `src/server/routes/share.ts` | 同 |
| server | `src/server/server.ts` | base store 构造改读 `config.users.owner.workspace ?? <workspace>/owner`；resolveStore 工厂传给 4 个路由；owner-warn 启动 log |
| cli | `src/cli/serve.ts` | `ensureProjectsRoot` 改成 `ensure(workspace) + ensure(owner-root)`；删 `guestProjectsRoot` 处理 |
| test | `src/server/server.test-helpers.ts` | helpers 改为接 `workspace` 字段；保留 `setupProjects` 兼容形态 |
| test | `src/server/server.multi-user.test.ts` | 已含 cross-user projects 隔离覆盖；扩到 sessions/resume/share cross-user |
| test | `src/users/store.test.ts` | `projectsRootFor` override / 默认 / 嵌套校验 |
| test | `src/config/schema.test.ts` | workspace + override 校验、cross-field superRefine |
| spec | `openspec/specs/config/spec.md` | 重写 projectsRoot/guestProjectsRoot 段为 workspace + users override |
| spec | `openspec/specs/auth/spec.md` | webauthn pair-init policy 改成显式 require kind=owner，去掉数据层 invariant 措辞 |
| spec | `openspec/specs/rest-api/spec.md` | projects 4 段（同前次 isolation 草案）+ sessions/share 段加 user-aware 解析 |
| spec | `openspec/specs/rest-api/multi-user.spec.md` | `POST /api/auth/token` 接受任意 user；`/api/me/quota` 不变 |
| docs | `docs/deployment.md` | workspace 字段说明 + owner override 示例 |

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| Data 层 user 对称 | `User.kind` 不再决定 store 解析 / device 持有 / token 颁发；只在 policy assert 中读取 |
| owner 仅可 webauthn pair | `POST /api/auth/webauthn/pair-init` 显式 require `req.user.kind === 'owner'`，403 mask |
| 任意 user 可 token 登 | `POST /api/auth/token` 不查 kind；TokenStore.verify + UserStore.findById 走完即颁 cookie |
| 路由按 user 解析 ProjectStore | 4 个路由（projects + sessions + sessions-resume + share）全部 `resolveStore(req.user)`；req.user 必经 cookie 中间件设置 |
| owner 不限额 | hook check 保留 `user.kind === 'owner'` 跳过；policy 显式 |
| user 隔离 | store 工厂按 username 切；`<workspace>/<username>` 默认或 user override 绝对路径；store cache 同 username 同实例（防并发写 state 竞争） |
| owner override 可选 | `users.owner.workspace` 缺失 → 默认 `<workspace>/owner`；中性启动 warn 提示可选配置 |
| override 路径不冲突 | superRefine：override 互不嵌套，与 `<workspace>/<其他 user>` 不重叠 |
| 同进程同 user 拿同 store 实例 | `Map<username, ProjectStore>` cache；`.projects-state.json` 不被并发写 |
| 老 device 自动迁移 | DeviceStore 启动时 lazy backfill 缺 `userId` → owner.id；零仪式 |
| Schema bump 强制 prod 同步 | ship 时主动请用户授权改 `~/.config/ccanywhere/config.json`；deploy 后跑 healthz 验 fatal |

## 不做

- owner 多人化（你明确说唯一）
- 完全去 `kind` 字段（policy 仍需）
- user 的 webauthn pair（policy 仍只 owner）
- ProjectStore 内部多 root 支持（保留单 root 一 state 假设）
- cc 窗口命名 → session name（独立 backlog）
- feedback 1/2/3（UI guard + 文案）独立 ~40 LOC bugfix，单独 PR
- internal-multi-user 的 quota 数据 schema 改动
- workspace fs path 自动迁移工具（仅 owner override 字段调整 + 旧 `Projects-guests` 删除是 ship 时单次操作）
- ccusage / 其他 user 类的非 owner 自动建（owner 仍是 install 时唯一自动 user）

## 影响范围

- **owner 视角**：dogfood 后 user 验证看不到 owner 项目少了一份 ProjectStore；
  ship + 改 config 后行为 0 变化（owner override `/Users/redcontritio/Projects`）
- **user 视角**：不再被 owner 数据污染；浏览 / 创建 / 删除 / 历史
  全部按自己 workspace 走；可创建 session（不再 project_not_found）
- **prod fs**：mkdir `~/ccanywhere-workspace/`；删 `~/Projects-guests/`（含空
  `e2e/` mkdir）；e2e user 下次登入后自动 mkdir `~/ccanywhere-workspace/e2e/`
- **配置**：`~/.config/ccanywhere/config.json` 三字段调整（删 2 个 + 加 2 个）
- **后续 dogfood**：reframe 完接续 quota dogfood（同张 token 还有效）
