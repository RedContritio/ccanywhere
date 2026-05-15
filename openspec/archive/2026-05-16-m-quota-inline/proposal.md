---
status: in-flight
---

# Proposal: m-quota-inline — Quota enforcement 从 hook 回环搬入 ccanywhere 内嵌

## Intent

m-quota-cost-tracking (#46, archived 2026-05-11) 把 quota enforcement 寄
生在 cc 的 `UserPromptSubmit` hook：cc 子进程读 `~/.claude/settings.json`
hook command → fork curl → HTTP loopback → ccanywhere `/api/hook/:sid/UserPromptSubmit`
→ ccusage 算 + decide block → 返 cc 协议 JSON → cc 解析 stdout。

**ccanywhere 是 cc 子进程的爹，却反过来当 cc 的 HTTP 客户端去查问 cc 的内部状态**。
代价：

- 每次 ccanywhere 重启 `internalHookToken` 重新生成 → user 必须手工同步
  到 settings.json，否则所有 hook 静默 401（dogfood 实证：缺 hook 配置 →
  quota 完全不工作 + 完全没诊断信号）
- 5 层间接（cc → shell → curl → HTTP → ccanywhere），开销大于 quota check
  本身
- 不可 CI 测：手工配置不能进自动化
- token 同步漂移概率随重启次数线性增长

ccanywhere 已经掌握 quota check 需要的全部要素（spawn cc 持 PTY 句柄、
强制 `--session-id` 让 jsonl 路径可推、有 ccusage 算法、控制 PTY input/
output stream），完全可以**内嵌 quota enforcement**，不依赖外部回环。

## Scope（精准）

只把 **quota** 这条 enforcement 路径从 hook 内嵌；hook 系统作为 session
state machine 通道（PreToolUse / Stop / SubagentStop 驱动 busy↔idle）有
独立价值，**保留不动**。

| 保留 | 改造 |
|---|---|
| `src/server/routes/hook.ts` 路由本身 | 删 UserPromptSubmit 分支里的 `checkQuota` 调用与 quota block 路径 |
| `internalHookToken`（其他 hook 仍要鉴权） | — |
| settings.json 4 个 hook 配置（state machine 仍依赖） | UserPromptSubmit hook 配置变成**纯 state transition**（busy 切换），quota 不再依赖它；user 漏配 UserPromptSubmit 也不影响 quota |
| `Session` busy↔idle state machine | — |

## 决策

### 1. PTY input quota gate

WS handler `case 'input'` 写 PTY 前查 quota（`src/ws/server.ts:251-253`）：

```ts
case 'input':
  if (resolveQuotaGate(session) === 'blocked') {
    sendFrame(sock, { type: 'quota_exhausted', reason });
    return;
  }
  session.write(f.data);
  return;
```

`resolveQuotaGate(session)` 内部查 `userStore.findById(session.info.userId)
.quota` 命中 limit → blocked。owner kind 永远 pass。

**input gate 是同步、无文件 IO 的内存查询**——单次开销忽略。

**与原 hook 行为差异**：

- 原 hook 在 user prompt submit 时拦截（cc 内部时刻），block JSON 返回 cc，
  cc 显示 "quota exhausted" 在终端。
- inline gate 在 PTY input 写入前拦截（更早），cc 完全不感知 user input；
  block 提示走 web UI 渠道（新 ServerFrame `quota_exhausted`），不污染
  PTY scrollback。
- 行为更干净：cc 的 conversation 历史不会有"用户问问题但被 block"的孤立
  记录。

### 2. jsonl fs.watch 自动刷新 quota.used

session spawn 时启动 jsonl 文件 watcher：

```ts
// QuotaWatcher 模块
const path = ccJsonlPathOf(session.info.cwd, ccSessionIdOf(session));
fs.watch(dirname(path), (event, filename) => {
  if (filename === basename(path)) {
    debounce(async () => {
      const usage = await ccusageCalc(path, user.createdAt);
      userStore.setQuotaUsage(user.id, usage.costUsd, usage.totalTokens);
    }, 500);
  }
});
```

session.dispose() 时 close watcher（防 fd 泄漏）。

debounce 500ms 避免 cc batch 写 jsonl 期间触发多次（cc 可能逐行 append 也
可能 stream-flush）。

owner kind session 不启动 watcher（没意义）。

**与原 hook 行为差异**：

- 原 hook 在 `UserPromptSubmit` 时刻同步算 ccusage 并写回；首轮 prompt
  jsonl 还没刷盘 → 当 0 用量放行；后续轮次重算累计。
- inline watch 是 cc 写 jsonl 后异步触发；首轮 cc 处理完毕 jsonl 写入
  后约 500ms 内 quota.used 更新。
- 副作用：dogfood feedback "第一轮对话后 token 消耗未更新" 直接 fix——
  现在 input gate 永远基于 watcher 最新写入的 quota.used，hook 缺失也照常
  更新。

### 3. WS protocol 加 `quota_exhausted` server frame

```ts
// ws/protocol.ts ServerFrameSchema 增加：
{ type: 'quota_exhausted', reason: string }
```

web 端收到后：

- 显示 toast / dialog："quota exhausted: <reason>"
- 不影响其他 frame 流；session 仍 alive，user 仍可关闭 / 切换
- web quota panel 自动 refetch（已有 polling 30s + ws block 事件即时
  refetch 机制 from m-quota-cost-tracking）

### 4. 删 hook.ts 的 quota check 分支

```ts
// hook.ts
if (event === 'UserPromptSubmit' && options.userStore !== undefined) {
  const { block } = await checkQuota(options.userStore, session);
  if (block !== null) {
    // ...
    await reply.code(200).send(block);
    return;
  }
}
```

整段删掉。剩下纯 state transition 逻辑。

`checkQuota` / `decide` / `QuotaBlockDecision` / `QuotaCheckOutcome` 这些
helper 全部移除（hook.ts 只剩 state machine + 路由壳）。

### 5. ccusage 模块复用

`src/quota/ccusage.ts` `ccusageCalc(path, sinceTimestamp)` 不动，新模块
`src/quota/watcher.ts` 复用它。

## 落地点

| 文件 | 改动 |
|---|---|
| `src/quota/watcher.ts` (新) | `class QuotaWatcher` —— per-session fs.watch + debounce + setQuotaUsage 调度；提供 start(session, user) / stop(sessionId) / closeAll() |
| `src/session/manager.ts` | 注入可选 QuotaWatcher；spawn / resumeDeadStub 末尾 `watcher?.start(session, user)`；session dispose / killAll 调 `watcher?.stop(sid)` |
| `src/ws/server.ts` | input frame 处理前加 quota gate；新加 `resolveQuotaGate` helper（依赖注入 userStore） |
| `src/ws/protocol.ts` | ServerFrame 加 `{ type: 'quota_exhausted', reason: string }` |
| `src/server/routes/hook.ts` | 删 UserPromptSubmit 的 checkQuota 调用 + 删 checkQuota / decide / 相关 helper / interface；保留纯 state transition 逻辑（应该剩 ~50 LOC） |
| `src/server/server.ts` | 构造 QuotaWatcher 并注入 SessionManager + ws handler |
| `web/src/state/quota.ts` 或 `web/src/api.ts` | 处理 `quota_exhausted` ws frame，触发 toast + quota panel refetch |
| `openspec/specs/hooks/spec.md` | "quota 单一 enforcement 点 = UserPromptSubmit hook" 改为 "quota 单一 enforcement 点 = ws input gate"；hook 仅做 state transition |
| `openspec/specs/ws-protocol/spec.md` | 加 `quota_exhausted` frame |
| 测试 | watcher 模块单测；ws input gate 集成测；hook.ts checkQuota 删除后保留的 state machine 测试不动 |

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| quota gate 在 cc 之前拦截 | `case 'input'` switch case 第一行检查；通过才 `session.write` |
| owner 不被 block | `userStore.findById(session.info.userId).kind === 'owner'` 直接 pass |
| jsonl 自动刷新 | session spawn 时绑 watcher；debounce 500ms 抖动；session dispose 时关 watcher |
| token 不再需要为 quota 同步 | quota 路径完全无 hook 调用；user 漏配 UserPromptSubmit hook 不影响 quota |
| 跨 session quota 累计 | watcher 通过 `userStore.setQuotaUsage` 写回 user 维度（与原行为一致）|
| 与 hook 系统共存 | hook 路由保留；其他 hook（PreToolUse / Stop / SubagentStop）行为不变；UserPromptSubmit 仍跑 state transition 但不再 quota check |
| owner kind session 零 fs.watch 开销 | watcher.start 内部 `if (user.kind === 'owner') return` 早退 |

## 不做

- 完全去 hook 化（PreToolUse/Stop/SubagentStop 仍走 hook 回环，state
  machine 价值独立）
- internalHookToken 持久化（仍 in-memory；其他 hook 路径不变，user 仍要
  手工同步一次。Step 2 的 settings.json 自动同步是独立 backlog）
- web UI quota panel 大改（现有 polling + 阈值黄警机制保留；只加
  `quota_exhausted` frame 触发的即时 refetch）
- 历史 jsonl backfill（启动时不扫描已存在的 jsonl 重算 quota；watcher
  从 spawn 时刻起算，符合"现在 + 未来"语义。冷启动场景的 quota.used 仍
  保留 user store 持久化的上次值）
- cc 子进程升级 / hook 协议变化的兼容（去 hook 化才彻底解决；本次只让
  quota 不依赖）

## 影响范围

- **dogfood quota 复验**：feedback 4 条全部直接 fix
  - "token 消耗未更新" → watcher 自动写回
  - "第二轮没反应"（即没 block）→ input gate 在第二轮 input 时拦截
  - 不再依赖 user 配 UserPromptSubmit hook
- **owner 视角**：零变化（owner kind 永远 pass quota gate；watcher 不启动）
- **现有 settings.json hook 配置不破**：UserPromptSubmit hook 仍可保留；
  hook.ts 收到事件仍跑 state transition；只是不再做 quota decide
- **新装 / 开源用户**：不配任何 hook 也能用 quota；state machine 退化但
  其他功能正常（state machine 退化是独立维度，BACKLOG 里若有需求再处理）
