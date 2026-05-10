# Proposal: M-multi-user — User-centric 鉴权 + Token + 静态 Share 导出

> 注：目录名 `m-share-and-trial` 是 v9 命名遗留，v12 内容 reframe 为 multi-user
> 主线。commit 阶段会随同 archive 重命名为 `m-multi-user`。
>
> **v12.1 修订（风险评审 10 条决策）**：
> - quota 从 token 上移到 user 维度（避免换 token 重置 quota）
> - cost.limitUsd / tokens.limit 可同时生效（enforcement 按先触达）
> - share 子系统（原 #45）推后到 v1+，base 不含
> - jsonl 路径派生 fail-closed + 启动期 sanity check
> - username 全程 NFC normalize；createLimitedUser 加 partial-failure cleanup
> - device store init runtime assert kind=owner
> - 新增前端 quota 面板（GET /api/me/quota）
> - 单轮 output 爆量保持现状（措辞已够，软上限 trade-off）

## Intent

ccanywhere v9 device-centric 字段堆叠（device 上挂 quota / readonly / shareLink /
allowedSessionIds）做了三件不相关的事，模型混乱、e2e 自动化困难。v12 reframe 为
**user-centric**，把三件事拆到三个独立 entity，**share 完全脱离鉴权层**：

- **User**：身份层，token 的可替换持有人。`owner` 1 个 + `limited` N 个；**quota 挂在 user 上**
- **Token**：limited user 的登录凭证（owner CLI 颁），仅持 ttl + label，**不持 quota**
- **Share**（v1+ 推后）：session 静态 HTML 导出，公开 URL，与 user/device/token 完全解耦

并行收益：

- e2e 自动化路径直接（token-based，跳 webauthn 全部复杂度）
- multi-user first-class（朋友 first-class 实体，非 device 字段 hack）
- 吃掉 #19 M-device-readonly-watch（readonly = `user.quota.cost.limitUsd=0` 或 `tokens.limit=0` 自然推出）
- 吃掉 #40 M-auth-expiry（token.expiresAt 强制 ≤ 7d 已含）

## v12.1 模型

### User

```ts
User {
  id: string                                  // uuid
  username: string                            // [中英文+空格+下划线]{1,32}，全程 NFC normalize
  kind: 'owner' | 'limited'
  createdAt: number
  lastLoginAt: number | null
  quota: {                                    // v12.1 上移到 user
    cost:   { limitUsd: number | null, usedUsd: number },
    tokens: { limit:    number | null, used:    number }
  }
}
```

- **owner**：仅一个，首次启动自动建（`username='owner'`）；走 webauthn pair；
  `projectsRoot = config.projectsRoot`；`quota.cost.limitUsd / tokens.limit` 均 null（不限）
- **limited**：N 个，owner CLI 显式创建；走 token；
  `projectsRoot = <config.guestProjectsRoot>/<username (NFC)>/`；
  `cost.limitUsd / tokens.limit` 至少一个非 null（颁发约束）
- **不实现 user delete**：username 永久占用；fs 目录已存在则 reject 创建（避免误盖现有数据）
- **NFC normalize**：username 进 store / fs guard / mkdir / readdirSync 比对全程 `.normalize('NFC')`
- **createLimitedUser cleanup**：写入顺序为 `mkdir → users.json`；mkdir 成功但 users.json 失败 → 回滚 `rmdir`，避免 fs guard 死锁
- **owner CLI topup**：`user quota set <name> [--cost-usd N] [--tokens N] [--reset]` 调整 limit / 重置 used

### Device（仅 owner 持有）

webauthn pair 字段不变，加 `userId: string`（恒指向 owner.id）。
首次启动迁移：现有 device 全部划归自动建的 owner user。

**v12 invariant**（runtime assertion）：
```ts
// device store init / authenticate 路径
assert(user.kind === 'owner', 'v12: device 仅 owner 持有；如后续支持 limited webauthn，需同时取消这条 invariant');
```

### Token（仅 limited 持有；v12.1 不再持 quota）

```ts
Token {
  id: string
  userId: string                              // 指向 limited user
  tokenHash: string                           // sha256(token) hex，明文不存
  label: string | null
  createdAt: number
  expiresAt: number                           // 必填，<= createdAt + 7d (hardcoded ttl 上限)
  status: 'active' | 'revoked'
  // v12.1: quota 移到 user，token 仅做身份认证
}
```

- **颁发**：仅设 ttl + label；user.quota 是用户层属性，不随 token 变化
- **同 user 多 token**：alice 一个 token 失效，owner 颁新 token，仍属 alice，
  project dir 不变，**user.quota 持续累加（不重置）** → quota 不被 token rotation 绕过
- **登录**：`POST /api/auth/token { token }` → server constant-time 比对 hash → 颁 cookie session

### Share（v1+ 推后）

> v12 原方案使用 cc 子进程让 LLM 渲染 HTML，被风险评审否决（不稳定 / 反向 quota UX / cc CLI flag 真实性存疑）。
> programmatic 路径（读 jsonl + 模板渲染 ~150 LOC）保留为 v1 实施目标。
> **本 v12.1 base 不含 share；schema/REST/前端均推后**。

### Project Dir 隔离

```
owner             cwd 必须 in config.projectsRoot 子树
limited <name>    cwd 必须 in <config.guestProjectsRoot>/<name (NFC)>/ 子树

guard 1: 创建 limited user 时若 fs <guestRoot>/<name (NFC)>/ 已存在 → reject
guard 2: 创建 user 写入顺序 mkdir → users.json；任一步失败回滚已建状态
guard 3: session 创建时 cwd 不在 user.projectsRoot 子树 → 401
guard 4: session listing 仅返 session.userId === current user.id 的
```

### 鉴权流程

```
owner login:    POST /api/auth/webauthn/login-{init,complete}  → cookie
limited login:  POST /api/auth/token { token }                  → cookie (ttl ≤ token.expiresAt)
share view:     (v1+) 推后

ws upgrade /ws/sessions/:id:
  cookie → resolve user
  → session.userId === user.id  否则 401 + close

同浏览器同时只一个 user (cookie 互踢)；切 user 必先 logout
```

### Quota 检查（ccusage 集成，v12.1）

**单一 enforcement 点 = `UserPromptSubmit` hook**（cc 必触发，ws input 帧不再 check）：

```
on UserPromptSubmit (sessionId, cwd):
  session = sessions.get(sessionId)
  user = users.get(session.userId)
  if user.kind === 'owner': return { block: false }       // owner 不限

  // v12.1 fail-closed：jsonl 缺失立即 block，避免 cc 升级改 path encoding 后静默漏额
  jsonlPath = ccJsonlPathOf(cwd, sessionId)               // 启动期已 sanity check
  if !fs.existsSync(jsonlPath):
    return { block: true, message: 'usage log unavailable (fail-closed)' }

  // ccusage-style calculator: 累加 since user.createdAt（不是 token.createdAt）
  usage = ccusageCalc(jsonlPath, sinceTimestamp = user.createdAt)
  user.quota.cost.usedUsd = usage.costUsd
  user.quota.tokens.used  = usage.totalTokens
  persist(user)

  // v12.1 双限制可同时生效，按先触达
  if user.quota.cost.limitUsd !== null && usage.costUsd >= user.quota.cost.limitUsd:
    return { block: true, message: 'cost quota exhausted' }
  if user.quota.tokens.limit !== null && usage.totalTokens >= user.quota.tokens.limit:
    return { block: true, message: 'tokens quota exhausted' }

  return { block: false }
```

**启动期 sanity check**（fail-closed 的前置）：
```
server boot:
  // 用 owner.projectsRoot 下任一已知 jsonl 路径反推 ccJsonlPathOf 算法
  // 若算出的 path 与已知 jsonl 不匹配 → 启动失败（要求人工排查 cc 升级影响）
```

**单轮爆量 trade-off**：limit=$5 时单轮 output 仍可能跑出 $50 cost（hook 是 best-effort，
"超额最多一轮"字面对，但单轮可数倍超 limit）。owner 颁 limit 时按预算 1/N 留 buffer。

### mac CLI

```bash
# user 管理（owner 全权，cliToken 鉴权）
ccanywhere user create <username> --ttl 7d \
  [--quota-cost-usd 5.0] [--quota-tokens 100000]
  → username NFC normalize
  → mkdir <guestRoot>/<username>/  (mode 0700)
  → 若已存在则 reject
  → cost.limitUsd / tokens.limit 至少一个非 null（owner 不受此约束）
  → 创建 limited user + 持 quota
  → 颁初始 token (ttl-only)
  → stdout 输出 token 字符串

ccanywhere user list

ccanywhere user quota set <username> \
  [--cost-usd N | --tokens N | --reset]
  → topup limit 或 reset usedUsd/used 为 0
  → 至少一个 limit 非 null 的约束依旧

# token 管理（不再持 quota）
ccanywhere token issue <username> --ttl 7d
  → 输出新 token 字符串
ccanywhere token list [--user <username>]
ccanywhere token revoke <tokenId>

# share 命令（v1+ 推后）

# 不实现 user delete
```

### REST API（user-facing）

```
POST   /api/auth/token                        body: { token } → cookie
POST   /api/auth/logout                       清 cookie

GET    /api/me/quota                          v12.1 新增：current user 的 quota 状态
                                                返回 { cost: {...}, tokens: {...}, kind }

GET    /api/sessions                          list (filter by current user)
POST   /api/sessions                          cwd 必须 in user.projectsRoot 子树
DELETE /api/sessions/:id

# share endpoints (v1+) 推后
```

### 内部 API（cliToken 鉴权）

```
POST   /api/internal/users                    body: { username, kind, quota, ttlMs }
GET    /api/internal/users
PATCH  /api/internal/users/:id/quota          v12.1 新增：body: { cost?, tokens?, reset? }
POST   /api/internal/tokens                   body: { userId, ttlMs }    v12.1 不再含 quota
GET    /api/internal/tokens
DELETE /api/internal/tokens/:id

# share internal endpoints (v1+) 推后
```

### 前端 UX

- **登录页**：webauthn pair 入口（owner）+ token 输入框（limited）
- **terminal-header**：
  - **quota 面板入口**（v12.1 新增）：icon button → radix-ui dialog
    - 显示 `cost.usedUsd / cost.limitUsd` + `tokens.used / tokens.limit` 进度条
    - 80% 阈值黄警，hook block 时 toast 复用同一面板
    - polling `GET /api/me/quota`（30s 间隔；ws 上 hook block 事件触发立即 refetch）
- **/share/* 路径**（v1+ 推后）

### 测试自动化路径（v12.1 直接化）

```ts
// playwright globalSetup
const token = execSync(
  'ccanywhere user create e2e --ttl 24h --quota-tokens 100000',
  { env: { ...process.env, CCANYWHERE_CONFIG: STAGING_CONFIG } },
).toString().trim();

await ctx.request.post('/api/auth/token', { data: { token } });
const cookies = await ctx.cookies();
await ctx.addCookies(cookies);

// per spec: page.goto(STAGING_URL) → 已登录态
```

webauthn pair 流程仅 owner 一处，e2e 不覆盖（用户手测）；其他业务（session
CRUD / cwd 隔离 / quota 计数 / token revoke / 多 user 隔离）全 e2e。

## Task 拆分（v12.1）

| # | scope | LOC |
|---|---|---|
| **#44 M-user-token-base** | User store（owner 自动建 + limited 创建 + NFC normalize + fs guard + cleanup）+ user.quota（cost/tokens 双限制）+ Token store（hash store + ttl ≤ 7d，不持 quota）+ 鉴权改造（cookie → user → session.userId 校验）+ cwd 隔离 + mac CLI user/token + `user quota set` + 老 device 迁移划归 owner（runtime assert kind=owner）| ~770 |
| **#46 M-quota-cost-tracking** | ccusage cost calc（jsonl 解析 + since user.createdAt）+ 启动期 path encoding sanity check + UserPromptSubmit hook 集成（双限制按先触达 + fail-closed）+ 前端 quota 面板（GET /api/me/quota + polling + 阈值黄警）| ~580 |
| **#45 M-share-static-export**（v1+ 推后） | programmatic jsonl→HTML 渲染 + share REST + 公开 view + caching headers + 前端 dialog/list/view + sweeper | ~600 |

合计 v12.1 base ~1350 (code) + ~600 (test/spec/docs) = ~1950 LOC

#45 推后到 v1+：proposal §Share 段保留方向，但 base 不实施；待 #44+#46 ship 后再启动。

## 推进顺序

1. commit 当前 **#43**（cookieName / configDir / --config，已 ready）
2. **#44** user-token-base（解锁 e2e + multi-user）
3. user 部署 staging（docs §9）
4. **#32** e2e backbone v12（globalSetup token 路径，~40 LOC）
5. **#46** quota-cost-tracking
6. **#36** e2e chip spec v12（3 spec 走真 staging，~120 LOC）
7. (v1+) **#45** share-static-export

## 与现有 task 的关联

- 替代 **#19 M-device-readonly-watch**：readonly = `user.quota.cost.limitUsd=0` 或
  `tokens.limit=0`，自然路径，无需独立 task。归档 #19
- 替代 **#40 M-auth-expiry**：token.expiresAt 强制 ≤ 7d 已含。归档 #40
- 解锁 **#32 / #36** e2e：token-based globalSetup 替代 webauthn CDP 复杂度
- **#45 推后到 v1+**：cc 子进程 LLM 渲染 HTML 方案被风险评审否决；programmatic 路径作为 v1 实施目标

## 已 reconsider 评审通过的设计决策（v3 → v12.1）

- v3 fixture self-contained：放弃，过度限制 playwright 真浏览器能力
- v4 真 staging 链路：保留
- v5 admin mint-cookie：合并
- v6 三种独立模式：合并到字段值差异
- v7 平铺 readonly + quotaRounds：reasoner 改嵌套 permissions
- v8 reasoner 修正 quota 计数（UserPromptSubmit）
- v9 用户洞察 readonly = quota 0，消除 canInput
- v10 用户引入 user 抽象（多 user）
- v11 用户校正 share = 静态导出（脱鉴权）+ 二元分流（owner=webauthn / limited=token）
- v12 用户简化：不实现 user delete（fs 目录已存即拒）+ quota check 单点 = UserPromptSubmit hook
- **v12.1 风险评审（10 条决策）**：
  - quota 上移 user 维度（治可绕过）
  - cost/tokens 双限制按先触达（治"二选一"过严）
  - jsonl fail-closed + 启动期 sanity check（治静默失效）
  - share v0 砍掉 / 推后到 v1+（治 LLM 渲染不稳定 + 反向 UX）
  - username 全程 NFC normalize（治 mac fs case）
  - createLimitedUser partial-failure cleanup（治 fs guard 死锁）
  - device store init kind=owner runtime assert（治隐含 invariant）
  - 前端 quota 面板（治 limited UX 缺口）
  - 单轮 output 爆量保持现状（trade-off 文档化）
  - share view caching headers（v1+ 推后随 #45）

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| owner webauthn 路径 0 改变 | 老 device 一次性迁移划归 owner.id；流程不变 |
| limited 不能登 webauthn | login-init 路径仅认 owner kind |
| user 必带限制（v12.1） | limited user 创建 / `quota set` 时 cost.limitUsd 与 tokens.limit 至少一个非 null（owner 例外，两者均 null）|
| token ttl 不超 7d | token issue 强制 expiresAt - createdAt ≤ 7d，超出 reject |
| limited 之间隔离 | cwd in user.projectsRoot 子树；session listing filter；ws upgrade userId 校验三层 |
| owner 不接管 limited | 不实现跨 user 路径；需要时 owner 颁 token 自登目标 user |
| **quota 不被 token 切窗口绕过（v12.1）** | quota 累加 since user.createdAt，与 token rotation 解耦 |
| **quota 双限制按先触达（v12.1）** | hook check cost / tokens 任一超 limit 即 block |
| **quota 不被 hook 静默漏额（v12.1）** | jsonl 缺失 fail-closed；启动期跑 path encoding sanity check |
| 同 host 多 instance 隔离 | cookieName + configDir（#43 已落） |
| **user 创建幂等且不误盖（v12.1）** | username 已存在 reject；fs `<guestRoot>/<NFC(name)>` 已存在 reject；NFC normalize 全程；mkdir → users.json 写入顺序 + 失败回滚 |
| **device-owner 耦合可见（v12.1）** | device store init / authenticate 路径 runtime assert(user.kind === 'owner') + 显式 invariant 注释 |
| share 子系统（v1+ 推后） | base 不含；programmatic jsonl→HTML 路径作为 v1 实施目标 |
| 单轮 output 爆量 | 已知软限 trade-off：hook best-effort，单轮可数倍超 limit；owner 设 limit 时按预算 1/N 留 buffer |
