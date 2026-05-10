# Tasks: M-multi-user (v12.1)

整体 design 见 `proposal.md`。本文件列三段独立 commit 的具体 task。

> **v12.1 改动摘要**（vs v12）
> - quota 字段从 token 移到 user → 影响 #44 schema / store / CLI / API / 测试，#46 hook 路由
> - share v0 砍掉，#45 整段推到 v1+ deferred
> - 加 NFC normalize / partial-failure cleanup / 启动期 sanity check / device-owner runtime assert / 前端 quota 面板
> - 双 limit 按先触达（取代 token 二选一约束）

**Store init 顺序约束（dependency note）**：
`user store` 必须先于 `device store` 完成 init（device fallback `userId = ownerUser.id` 依赖 owner 已建）；server 启动入口处显式串行调用，不并发。

---

## #44 M-user-token-base（base，~770 LOC）

### Schema / Store

- [ ] T1. `src/users/types.ts` 新建：
  ```ts
  User {
    id, username, kind: 'owner' | 'limited',
    createdAt, lastLoginAt,
    quota: {
      cost:   { limitUsd: number | null, usedUsd: number },
      tokens: { limit:    number | null, used:    number }
    }
  }
  ```
  - owner: `cost.limitUsd / tokens.limit` 均 null；limited: 至少一个非 null

- [ ] T2. `src/users/store.ts` 新建：
  - JSON persistence `<configDir>/users.json` (mode 0600)
  - load 时若无 owner kind → 自动建一条（username='owner'，quota 两 limit 均 null）
  - `createLimitedUser(name, opts)`：
    - **T2.1** username `.normalize('NFC')` 后再做后续校验
    - 校验字符集 `[一-龥㐀-䶿a-zA-Z0-9 _]{1,32}`
    - 校验 `cost.limitUsd / tokens.limit` 至少一个非 null
    - fs `<guestRoot>/<name (NFC)>/` 不存在 → mkdir 0700
    - **T2.2** 写入顺序 `mkdir → users.json`；users.json 写失败 → `rmdir` 回滚（避免 fs guard 死锁）
  - `findByUsername / findById / list`：比对前 NFC normalize
  - `setQuotaUsage(userId, costUsd, totalTokens)`：persist 累加
  - `setQuotaLimit(userId, opts)`：owner CLI `user quota set` 调用，至少一个 limit 非 null 约束依旧

- [ ] T3. `src/tokens/types.ts` 新建：`Token { id, userId, tokenHash, label, createdAt, expiresAt, status }`（v12.1 不再持 quota）

- [ ] T4. `src/tokens/store.ts` 新建：
  - JSON persistence `<configDir>/tokens.json` (mode 0600)
  - `issueToken(userId, opts)`：
    - 校验 ttl ≤ 7d hardcoded
    - 生成 32B hex token，存 sha256 hash
    - 返回明文 token（仅这一次）
    - **去 quota 二选一约束**（v12.1 移到 user）
  - `verifyToken(plaintext) → Token | null`：constant-time
  - `revoke(tokenId)` / `list(userId?)`

- [ ] T5. `src/devices/store.ts` 改：
  - device 加 `userId: string` 字段
  - load 老 record 默认填充 `userId = ownerUser.id`
  - **T5.1** init / authenticate 路径加 `assert(user.kind === 'owner')` + 注释 `// v12: device 仅 owner 持有；如后续支持 limited webauthn，需同时取消这条 invariant`
  - **T5.2** server 启动入口确保 user store init 完成后再 init device store

### 鉴权改造

- [ ] T6. `src/server/auth.ts` `hookEarlyAuth`：
  - cookie → sessionToken → device 或 token → user
  - 把 `req.user` 注入给 downstream handler
  - cookie 失效 / token revoked / token expired → 401

- [ ] T7. `src/server/routes/auth.ts`：
  - 加 `POST /api/auth/token` body: `{ token }` → cookie session（ttl ≤ token.expiresAt）→ update user.lastLoginAt
  - **T7.1** 加 `GET /api/me/quota` → 返回 `{ kind, cost: { limitUsd, usedUsd }, tokens: { limit, used } }`（v12.1 新增；前端 quota 面板用）

- [ ] T8. `POST /api/auth/webauthn/login-init` 加 user kind 校验：仅 owner 走 webauthn，limited 明确 reject

### Session / cwd 隔离

- [ ] T9. `src/session/manager.ts` Session 加 `userId: string`；spawn 时绑当前 user

- [ ] T10. `src/server/routes/sessions.ts`：
  - `POST /api/sessions`：cwd 必须 startsWith user.projectsRoot；否则 403
  - `GET /api/sessions`：filter by `session.userId === req.user.id`
  - `DELETE /api/sessions/:id`：仅当 session.userId === user.id 才放行

### WS upgrade 改造

- [ ] T11. `src/ws/server.ts` upgrade hook：cookie → user → `session.userId === user.id` 否则 close + 401

- [ ] T12. ws upgrade 路径不再做 quota check（移到 UserPromptSubmit hook，#46）

### Mac CLI

- [ ] T13. `src/cli/user.ts` 新建：
  - `user create <name> --ttl 7d [--quota-cost-usd N] [--quota-tokens N]`
    - 至少一个 quota limit 非 null
    - 调 internal API 创建 user + 颁初始 token，stdout 输出 token 字符串
  - `user list`
  - **T13.1** `user quota set <name> [--cost-usd N | --tokens N | --reset]`（v12.1 新增）
    - topup limit 或 reset usedUsd/used 为 0
    - 至少一个 limit 非 null 约束依旧

- [ ] T14. `src/cli/token.ts` 新建：
  - `token issue <name> --ttl 7d`（v12.1 不再含 quota flag）
  - `token list [--user <name>]`
  - `token revoke <tokenId>`

- [ ] T15. `src/cli.ts` dispatch 加 `user` / `token` subcommand

### Internal API

- [ ] T16. `src/server/routes/internal.ts` 加：
  - `POST /api/internal/users` body: `{ username, ttlMs, quota }` → 创建 user + 颁初始 token
  - `GET /api/internal/users`
  - **T16.1** `PATCH /api/internal/users/:id/quota` body: `{ cost?, tokens?, reset? }`（v12.1 新增）
  - `POST /api/internal/tokens` body: `{ userId, ttlMs }`（v12.1 不再含 quota）
  - `GET /api/internal/tokens`
  - `DELETE /api/internal/tokens/:id`

### Config

- [ ] T17. `src/config/schema.ts` 加 `guestProjectsRoot: string`（绝对路径，必填新字段）
- [ ] T18. `loadConfig` 校验：`guestProjectsRoot` 与 `projectsRoot` 不重叠
- [ ] T19. server 启动时 `mkdir -p guestProjectsRoot` (mode 0700)

### 测试

- [ ] T20. `src/users/store.test.ts` 新建：
  - 首次启动自动建 owner（quota 两 limit 均 null）
  - createLimitedUser fs guard（已存在 reject）
  - username 字符集校验
  - **T20.1** NFC normalize 一致性：NFC 与 NFD 同字形输入命中同一 user
  - **T20.2** partial-failure cleanup：mock users.json 写失败 → fs 已 mkdir 的目录被 rmdir
  - **T20.3** limited user 必须至少一个 quota limit 非 null（两个 null 时 reject）
  - setQuotaLimit / setQuotaUsage 行为

- [ ] T21. `src/tokens/store.test.ts` 新建：
  - issueToken ttl > 7d reject
  - verifyToken constant-time
  - revoke 后 verify 返回 null
  - issueToken 不接收 quota 参数（接收时 schema reject）

- [ ] T22. `src/server/routes/auth.test.ts` 加：
  - POST /api/auth/token 成功 → cookie set
  - 失效 token → 401
  - limited user 走 webauthn login → reject
  - **T22.1** GET /api/me/quota：owner 返回 limit 均 null；limited 返回当前 quota 字段

- [ ] T23. `src/server/routes/sessions.test.ts` 加：
  - cwd 不在 user.projectsRoot 子树 → 403
  - listing filter by userId

- [ ] T24. `src/ws/server.test.ts` 加：alice token 试 upgrade bob 的 session → 401

### Spec delta

- [ ] T25. `specs/auth/spec.md` 改写：user / token / device 三层鉴权模型；device-owner invariant
- [ ] T26. `specs/sessions/spec.md` 加 cwd 子树约束 + ownership filter
- [ ] T27. `specs/rest-api/spec.md` 加 token login + GET /api/me/quota + internal user/token API
- [ ] T28. `specs/config/spec.md` 加 `guestProjectsRoot`

### 文档

- [ ] T29. `docs/deployment.md` 加 §10 多 user 配置：
  - guestProjectsRoot 设置
  - 创建第一个 limited user 示例
  - **T29.1** Troubleshoot 段：partial-failure 手动恢复（rm `<guestRoot>/<name>` 后重试 user create）

### 验证

- [ ] T30. tsc --noEmit + vitest run 全绿
- [ ] T31. 用户确认 commit

---

## #46 M-quota-cost-tracking（v12.1，~580 LOC）

### ccusage calculator

- [ ] T1. `src/quota/ccusage.ts` 新建：
  - 输入：cc jsonl path + sinceTimestamp
  - 解析 jsonl 每行 message 的 usage 字段（input/output/cache_read/cache_creation tokens）
  - 累加 totalTokens
  - 按 model 名查价格表
  - 返回 `{ costUsd, totalTokens, byModel }`
  - **v12.1: sinceTimestamp = user.createdAt（不是 token.createdAt）**

- [ ] T2. `src/quota/pricing.ts` 新建：硬编码当前 cc 模型价格表（input/output/cache_read/cache_creation per million tokens）；列出来源 + 同步策略

- [ ] T3. `src/quota/path.ts` 新建：cc jsonl 路径派生
  - 从 `cwd` 派生 encoded path（grep cc 实际算法，fixture 单测）
  - jsonl 文件名 = `<sessionId>.jsonl`
  - **T3.1** server 启动期 sanity check（v12.1）：
    - 用 owner.projectsRoot 下任一已知存在的 jsonl 反推 ccJsonlPathOf 算法是否一致
    - 不一致 → 启动失败 + 错误消息提示 "cc 升级可能改了 path encoding，需手动同步"

### Hook 集成

- [ ] T4. `src/server/routes/hook.ts` UserPromptSubmit handler（v12.1 fail-closed + user.quota）：
  - resolve session.userId → user
  - if `user.kind === 'owner'`: return `{ block: false }`
  - jsonlPath = ccJsonlPathOf(cwd, sessionId)
  - **T4.1** if `!fs.existsSync(jsonlPath)`: return `{ block: true, message: 'usage log unavailable (fail-closed)' }`
  - 调 ccusageCalc(jsonlPath, sinceTimestamp = user.createdAt)
  - persist `user.quota.cost.usedUsd / tokens.used`
  - **T4.2** 双限制按先触达：
    - if `cost.limitUsd !== null && usedUsd >= cost.limitUsd`: block 'cost quota exhausted'
    - if `tokens.limit !== null && used >= tokens.limit`: block 'tokens quota exhausted'
  - 否则 return `{ block: false }`

- [ ] T5. **session ↔ token 绑定移除**（v12.1）：quota 跟 user 不跟 token，hook 通过 `session.userId → user.quota` 直路由，无需 session.tokenId 字段

### 前端 quota 面板（v12.1 新增）

- [ ] T6. `web/src/components/quota-panel.tsx` 新建：radix-ui dialog
  - GET /api/me/quota（mount + 30s 间隔 polling）
  - cost / tokens 进度条；80% 阈值黄警；100% 红警
  - dialog 外触发关闭后停止 polling

- [ ] T7. `web/src/components/terminal-header.tsx` 加 quota icon button：
  - owner kind 时显示但内容为"无限制"
  - limited kind 时显示 mini 进度条

- [ ] T8. `web/src/ws.ts` SocketHandlers 接收 hook block 事件 → 触发 quota-panel 立即 refetch + toast 显示 message

- [ ] T9. `web/src/pages/workspace.tsx` quota 用尽 toast：当前用量 / 限额 + "联系管理员续期或换 token"

### 测试

- [ ] T10. `src/quota/ccusage.test.ts`：
  - mock jsonl fixtures，cost 计算与 ccusage 同款
  - sinceTimestamp 边界（since user.createdAt）

- [ ] T11. `src/quota/pricing.test.ts`：模型 → 价格映射

- [ ] T12. `src/quota/path.test.ts`（v12.1 新增）：
  - cc cwd→path encoding 与 fixture 一致
  - sanity check 失败 → 抛错
  - server 启动期调用 sanity check 的集成测试

- [ ] T13. `src/server/routes/hook.test.ts`：
  - owner → 始终放行
  - limited 未超 → 放行 + persist user.quota
  - limited 超 cost limit → block
  - limited 超 tokens limit → block
  - **T13.1** 双 limit 都设时按先触达（先到 cost 触发 cost message；先到 tokens 触发 tokens message）
  - **T13.2** jsonl 缺失 → block 'usage log unavailable'（fail-closed）
  - 当轮 in-flight 不打断（下一次 UserPromptSubmit 才 catch）

- [ ] T14. `web/src/components/quota-panel.test.tsx`（v12.1 新增）：
  - mock fetch，验证 polling 间隔 + 阈值变色
  - hook block 事件触发立即 refetch

### Spec delta

- [ ] T15. `specs/hooks/spec.md` 加 quota check / block 副作用 / fail-closed
- [ ] T16. `specs/auth/spec.md` 加 user.quota 字段 + token 不持 quota 的设计契约

### 验证

- [ ] T17. tsc + vitest 全绿
- [ ] T18. 用户确认 commit

---

## #45 M-share-static-export（v1+ deferred）

> **v12.1 决策**：cc 子进程 LLM 渲染 HTML 方案（原 v12 T3）被风险评审否决（不稳定性 + 反向 quota UX + cc CLI flag 真实性存疑）。
> programmatic jsonl→HTML 路径（~150 LOC）作为 v1 实施目标。
> **本 base 不实施 #45**；启动 v1 时再补完整 task 拆分。

骨架 reference（v1 启动时基础）：
- programmatic exporter（读 jsonl + 模板渲染 HTML，确定性）
- Share schema / store / sweeper
- REST：POST/GET/PATCH/DELETE /api/sessions/:id/shares + GET /api/shares
- 公开 view `GET /share/:token` + rate limit 100/min/IP + Cache-Control + ETag（v12.1 决策）
- 前端 share dialog / list / view

不在 v12.1 base 范围；不进推进顺序。

---

## 推进顺序（v12.1）

1. commit **#43**（cookieName / configDir / --config，已 ready）
2. **#44** user-token-base
3. user 部署 staging（docs §9）
4. **#32** e2e backbone v12.1（globalSetup token 路径，~40 LOC）
5. **#46** quota-cost-tracking
6. **#36** e2e chip spec v12.1（~120 LOC）
7. (v1+) **#45** share-static-export

## 归档（commit 时）

- [ ] 用户确认 v12.1 总体方向后，目录 `m-share-and-trial` 重命名为 `m-multi-user`
- [ ] 归档 #19 M-device-readonly-watch（被 v12.1 user.quota.cost.limitUsd=0 路径吃掉）
- [ ] 归档 #40 M-auth-expiry（被 v12.1 token.expiresAt 强制 ≤ 7d 吃掉）
- [ ] #45 task 拆分推到 v1+ 启动时再补完
