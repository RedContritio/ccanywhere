# Tasks: M-quota-cost-tracking

整体 design 见 `proposal.md`。三 chunk 独立 commit。

## Chunk A: utility 层（~250 LOC）

### A1. pricing 表

- [ ] `src/quota/pricing.ts` 新建：
  - `MODEL_PRICING: Record<string, { input, output, cache_read, cache_creation }>`
    （per million tokens）
  - opus-4-7 / sonnet-4-6 / haiku-4-5-20251001 三条
  - `priceFor(model: string)` 未知模型返回全 0 + 一次性 warn log
  - 来源链接 + 同步策略注释

- [ ] `src/quota/pricing.test.ts`：
  - 已知模型 → 期望价格
  - 未知模型 → 0 + 不抛
  - cache_read / cache_creation 价差正确（cache_read 比 input 便宜）

### A2. path encoding + sanity check

- [ ] `src/quota/path.ts` 新建：
  - `ccJsonlPathOf(cwd, sessionId): string` —
    `<home>/.claude/projects/-<cwd-with-/→->/<sessionId>.jsonl`
  - `runStartupSanityCheck(): SanityResult` —
    - 扫 `~/.claude/projects/*/[uuid].jsonl`
    - 取一个 → 反推 cwd → 回算 path → 对比
    - empty → `{ kind: 'skipped', reason: 'no jsonl' }` + warn log
    - mismatch → 抛 `QuotaPathError`（启动失败）
    - match → `{ kind: 'verified', samplePath }` + info log

- [ ] `src/quota/path.test.ts`：
  - ccJsonlPathOf 各种 cwd（含空格 / 长路径 / 根目录边界）
  - sanity check empty → skipped
  - sanity check 提供 mock fixture → verified
  - sanity check 不匹配 → 抛

### A3. ccusage calculator

- [ ] `src/quota/ccusage.ts` 新建：
  - `ccusageCalc(jsonlPath, sinceTimestamp): { costUsd, totalTokens, byModel }`
  - 读 jsonl line-by-line（不一次性 load 大文件）
  - 解析 message.usage `{ input_tokens, output_tokens,
    cache_read_input_tokens, cache_creation_input_tokens }`
  - 过滤 `message.timestamp < sinceTimestamp`
  - 按 model 调 priceFor → 累加 costUsd / totalTokens
  - 容错：单行 JSON 解析失败 → skip + log（不整体抛）
  - 返回 `{ costUsd, totalTokens, byModel: Record<model, { tokens, costUsd }> }`

- [ ] `src/quota/ccusage.test.ts`（fixture jsonl）：
  - 空文件 → 0 / 0
  - 单条 message → 正确价格
  - 多 model 混合 → byModel 分桶
  - sinceTimestamp 过滤：早于 since 的 message 被忽略
  - 损坏 line 不影响后续行累加
  - cache_read vs input token 价格差体现

### A4. 验证

- [ ] pnpm typecheck:all exit 0
- [ ] pnpm lint exit 0
- [ ] pnpm test exit 0（新增 ~15 case）
- [ ] 用户确认 commit chunk A

---

## Chunk B: hook 集成 + sanity 调用（~180 LOC）

### B1. hook UserPromptSubmit quota check

- [ ] `src/server/routes/hook.ts` 改：
  - registerHookRoutes 加 opts `{ userStore?, tokenStore? }`（optional：
    legacy 路径不传时跳过 quota）
  - UserPromptSubmit event 在 setState 之前插 quota check
  - resolve session → userId → user
  - owner kind → skip + 继续 setState
  - jsonlPath !exists → 视 usage={0,0}（first-prompt edge：不 block，
    persist 也不写 0 覆盖；仅当 jsonl 存在时 persist）
  - jsonl exists → ccusageCalc + setQuotaUsage
  - 双限制按先触达：先 cost 后 tokens
  - block 决策：cc protocol 要 hook 返回 stdout JSON 还是 reply status？
    （需 verify cc hook 协议；可能是 reply body `{ decision: 'block',
    reason: '...' }` 或 exit code）
  - 不 block 时仍走 setState('busy')

- [ ] `src/server/server.ts` buildServer 把 userStore 透传给
  registerHookRoutes

### B2. 启动期 sanity check

- [ ] `src/cli/serve.ts` bootstrap：
  - userStore + tokenStore + deviceStore init 之后
  - 调 `runStartupSanityCheck()`
  - skipped → warn 已在 path.ts 内打
  - verified → info 已在 path.ts 内打
  - 抛 QuotaPathError → process.exit(2) + 错误消息

### B3. 测试

- [ ] `src/server/routes/hook.test.ts` 新建（或扩 server.test.ts）：
  - owner UserPromptSubmit → 204 + state=busy（无 block）
  - limited 未超 → 204 + state=busy + setQuotaUsage 被调
  - limited 超 cost limitUsd → block decision 体现在 reply
  - limited 超 tokens limit → block decision
  - 双 limit 都设 + 先到 cost → cost message
  - 双 limit 都设 + 先到 tokens → tokens message
  - jsonl 不存在 → 不 block + 不 persist usage（保留旧 used 值）
  - 损坏 jsonl line → 不抛（fixture 内含坏行）

### B4. 验证

- [ ] typecheck / lint / lint:md / test 全 exit 0
- [ ] 测试数 +8 ~ +12
- [ ] 用户确认 commit chunk B

---

## Chunk C: 前端 quota panel（~150 LOC）

### C1. quota panel 组件

- [ ] `web/src/components/quota-panel.tsx` 新建：
  - radix-ui Dialog（已 dep）
  - GET /api/me/quota on mount + 30s polling
  - cost / tokens 双进度条；80% 黄警 / 100% 红警
  - owner kind 显示 "无限制" 文字
  - close 后停 polling

- [ ] `web/src/components/terminal-header.tsx` 改：
  - quota icon button（仅 limited 显示 mini bar）
  - click → 打开 dialog

### C2. ws block 事件

- [ ] `web/src/ws.ts` SocketHandlers：
  - 收到 server 端 error frame 含 'quota exhausted' message
  - 触发 quota-panel 立即 refetch
  - toast 显示 message + "联系管理员续期或换 token"

### C3. 测试

- [ ] `web/src/components/quota-panel.test.tsx`（vitest jsdom）：
  - mock fetch / setInterval
  - 80% → 黄色 class
  - 100% → 红色 class
  - close → clearInterval 被调
  - block 事件触发立即 refetch

### C4. 验证

- [ ] web 端 typecheck / lint / test exit 0
- [ ] 用户确认 commit chunk C

---

## Spec delta（chunk B / C ship 后）

- [ ] `openspec/specs/hooks/spec.md` 加 Requirement "quota check at
  UserPromptSubmit"：
  - owner skip
  - jsonl 缺失 → treat as 0（不 block）
  - 双限制按先触达
  - 当轮 in-flight 不 block
  - Scenario 表覆盖 owner / 未超 / cost 超 / tokens 超 / 双 limit

- [ ] `openspec/specs/auth/spec.md` Requirement "用户与令牌" 内加：
  - user.quota.{cost,tokens}.used 累加自 user.createdAt（不是 token.createdAt）
  - quota check 单点 = UserPromptSubmit hook
  - token rotation 不重置 quota

## 归档

- [ ] 三 chunk + spec delta 全 ship 后归档
  `openspec/changes/m-quota-cost-tracking/` →
  `openspec/archive/2026-05-11-m-quota-cost-tracking/`

## Commits

- 72787dc docs(openspec): m-quota-cost-tracking spec delta + archive
- 2cd2c19 feat(quota): m-quota-cost-tracking chunk C — web quota panel
- bd5de4b feat(quota): m-quota-cost-tracking chunk B — UserPromptSubmit hook enforcement
- 9cac3f0 feat(quota): m-quota-cost-tracking chunk A — pricing + path + ccusage utility
