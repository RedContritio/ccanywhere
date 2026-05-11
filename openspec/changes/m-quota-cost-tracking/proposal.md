# Proposal: M-quota-cost-tracking — limited user quota enforcement

## Intent

m-multi-user (v12.1, #44) ship 把 `user.quota.{cost,tokens}` 字段加上了，
但**实际累加 + 超限 block 路径完全未实施**。当前 limited user 形同虚设
（quota 限制只是字段，无 enforcement）。本 change 落地 v12.1 设计中
"quota 检查单点 = UserPromptSubmit hook" 的实施层。

## 已 ship 状态（依赖）

- `User.quota.cost.{limitUsd, usedUsd}` / `User.quota.tokens.{limit, used}`
  字段（#44）
- `UserStore.setQuotaUsage(userId, costUsd, totalTokens)` API（#44）
- `GET /api/me/quota` 路由返回 user.quota（#44）
- `req.user` 由 hookEarlyAuth 注入下游（#44）
- `src/server/routes/hook.ts` — 当前只有 state-transition 表（45 LOC），
  无 quota 逻辑

## 设计（沿用 v12.1 archive proposal）

### Hook 单一 enforcement 点

```
on UserPromptSubmit (sessionId, cwd):
  session = manager.get(sessionId)
  user = userStore.findById(session.info.userId)
  if user.kind === 'owner': return { block: false }

  jsonlPath = ccJsonlPathOf(cwd, sessionId)
  if !fs.existsSync(jsonlPath):
    # first-prompt edge: cc 可能还没 flush jsonl
    # treat as 0；不 block（下一次 hook fire 时 jsonl 应已存在）
    usage = { costUsd: 0, totalTokens: 0 }
  else:
    usage = ccusageCalc(jsonlPath, sinceTimestamp = user.createdAt)

  userStore.setQuotaUsage(user.id, usage.costUsd, usage.totalTokens)

  # 双限制按先触达
  if user.quota.cost.limitUsd !== null && usage.costUsd >= user.quota.cost.limitUsd:
    return { block: true, message: 'cost quota exhausted' }
  if user.quota.tokens.limit !== null && usage.totalTokens >= user.quota.tokens.limit:
    return { block: true, message: 'tokens quota exhausted' }
  return { block: false }
```

### 决策点（v12.1 archive 未覆盖，本 change 拍板）

| 决策 | 选项 | 拍板 |
|---|---|---|
| first-prompt jsonl 缺失 | block / treat 0 / retry | **treat as 0**（onboarding UX 优先；cc 一句话最多几十美分，远低于通常 limit） |
| 启动期 sanity check 在 `~/.claude/projects/` 空时 | skip+warn / fail / fixture | **skip + warn**（新部署机器不卡；首次 hook fire 时自动 self-check） |
| ccusage 实现 | npm dep / 自实现 | **自实现 jsonl 解析**（无 dep；schema 解耦） |
| 拆分 | one-shot / 二笔 / 三笔 | **三笔 A/B/C**（每 chunk 可独立验证） |

### Pricing 表

`src/quota/pricing.ts` 硬编码当前 cc 模型价格（per million tokens）：

```ts
PRICING = {
  'claude-opus-4-7': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25 },
  // ... 未列模型按 input/output rate 0 + warn 日志（fail-soft）
}
```

来源 + 同步策略：注释指 https://www.anthropic.com/pricing；每次 cc 升级
后人工 sync。未来 m-pricing-auto-sync 可考虑（不在本 change 范围）。

### cc jsonl path encoding

```ts
function ccJsonlPathOf(cwd: string, sessionId: string): string {
  // cc 实际算法：~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
  // encoded-cwd = cwd.replace(/\//g, '-')（cc CLI 行为，需验证 fixture）
  const encoded = cwd.replace(/^\//, '').replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', `-${encoded}`, `${sessionId}.jsonl`);
}
```

启动期 sanity check：
- 扫 `~/.claude/projects/*/[uuid].jsonl` 取一个真实路径
- 反推 cwd（解码 `-` → `/`）
- 用 `ccJsonlPathOf(reverseCwd, sessionId)` 回算，对比原路径
- 不匹配 → fatal 启动 +错误消息 'cc 升级可能改了 path encoding'
- 匹配 → log info
- projects 空 → skip + warn

### 前端 quota panel

- `web/src/components/quota-panel.tsx` radix-ui dialog
- mount + 30s polling `GET /api/me/quota`
- 双进度条（cost / tokens）；80% 黄警 / 100% 红警
- `web/src/components/terminal-header.tsx` icon button + mini progress
- ws block 事件 → trigger 立即 refetch + toast

## 范围

### chunk A (~250 LOC)

- `src/quota/pricing.ts` + 单测
- `src/quota/path.ts`（ccJsonlPathOf + sanity check）+ 单测
- `src/quota/ccusage.ts`（calculator）+ 单测（fixture jsonl）

### chunk B (~180 LOC)

- `src/server/routes/hook.ts` UserPromptSubmit handler 加 quota check
- `src/cli/serve.ts` 启动入口调 sanity check
- 单测：owner skip / first-prompt treat 0 / 未超 / 超 cost / 超 tokens /
  双限制按先触达 / persist setQuotaUsage

### chunk C (~150 LOC)

- `web/src/components/quota-panel.tsx` + radix dialog
- `web/src/components/terminal-header.tsx` quota icon button
- ws block 事件 client 处理
- 测试

### spec delta（chunk B/C ship 后）

- `openspec/specs/hooks/spec.md` 加 quota check / fail-soft (treat as 0) /
  block / 双限制按先触达 Requirement
- `openspec/specs/auth/spec.md` 加 user.quota 累加语义（since user.createdAt）

## 不做

- npm ccusage 包引入（自实现）
- pricing auto-sync（单独 task）
- Stop / PreToolUse hook quota check（v12.1 决策：单一 UserPromptSubmit
  enforcement）
- 在轮内打断（v12.1：当轮 in-flight 不 block，下一次 prompt 才 catch）

## 形式化保证（chunk B/C ship 后）

| 性质 | 保证机制 |
|---|---|
| quota 不被 token rotation 绕过 | ccusageCalc since user.createdAt（不是 token.createdAt） |
| owner 无限制 | hook handler 早退（owner kind skip） |
| 双限制按先触达 | 先 cost check 再 tokens check，前者命中即 return |
| first-prompt 不被误 block | jsonl 缺失 → treat as 0（不 block） |
| jsonl path 漂移检测 | 启动期 sanity check + fail 启动 |
| 当轮 cc 不被打断 | quota check 仅在下一次 UserPromptSubmit 触发 |

## 关联

- 依赖：m-multi-user (#44) — user.quota 字段 + UserStore.setQuotaUsage
- 与 m-fit-cols-dpr 并行（独立子系统）
- 解锁：限额 limited user 实际可用；docs/deployment §multi-user
  walkthrough 终于成立
- 不依赖：#32 e2e backbone / #36 e2e chip spec（这些是测试范围）
