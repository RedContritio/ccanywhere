---
status: planned
---

# Proposal: m-resume-args-helper — 抽 buildResumeArgs 纯函数

## Intent

m-session-persistence ship 后两轮 user feedback 暴露 cc args 错误（P7 删
冲突 `--session-id` + P8 resume 用 cc jsonl id 而非 web id）。两个 bug
在 `server.resume-dead-stub.test.ts` / `manager.persistence.test.ts` 都用
`sh` 作 spawn binary，sh 接无效 flag 立即退出，行为偶然与 cc panic-then-exit
相似让 test 通过。

抽 `buildResumeArgs(opts)` 纯函数集中 cc args 构造逻辑，单测覆盖各分支
args 形状。CI 友好（不依赖 cc binary）。

BACKLOG B11 提到方案 a (env-gate 真 cc binary 集成 test) 暂不做——cloud
runner 没 cc binary，CI 阻塞代价大于收益。

## 决策

D1. **helper signature**：`buildResumeArgs(opts: { webId: string;
    resumeSessionId: string | null | undefined }): string[]`。不绑
    `DeadStub` 类型让 helper 纯函数化 / 单测好造 fixture / manager 内部
    spawn lock key 计算也可复用同语义。

D2. **不抽 spawn opts 其它字段**：command / scrollbackBytes / cols / rows
    / env 仍 inline。它们要么来自 config 要么来自 request body，不构成
    cc args 形状的 regression risk。本次 fix 只覆盖 cc args 部分。

D3. **manager.ts line 192 resumeSessionId 计算暂不抽**：相同 `?? webId`
    fallback 逻辑也在 `resumeDeadStub` lock key 处出现，但意义略不同
    （args vs lock key）。保留 inline 避免 surface area 扩张，
    只共享 helper 输出值（cc jsonl id）的语义。

## 落地点

**新增**：
- `src/session/resume-args.ts` (~20 LOC)：`buildResumeArgs(opts)` +
  `getCcSessionId(opts)` （resumeSessionId ?? webId 抽出来共享，用于
  response payload / args 双场景，避免 inline 重复 fallback）
- `src/session/resume-args.test.ts` (~60 LOC)：覆盖
  - resumeSessionId === null → ['--resume', webId]
  - resumeSessionId === undefined → ['--resume', webId]
  - resumeSessionId === 'cc_X' (≠ webId) → ['--resume', 'cc_X']
  - args.length === 2 && !args.includes('--session-id')（regression
    guard，防 P7 bug 复发）
  - getCcSessionId 同样 3 分支 + identity assertions

**改写**：
- `src/server/routes/sessions-resume.ts`：line 93 + 100 改用 helper

## 形式化保证

F1. cc args 形状仅由 `buildResumeArgs` 产出。route 内不再 inline 构造。

F2. args 不含 `--session-id`（cc 视为与 `--resume` 冲突）。单测显式
    regression guard。

F3. cc jsonl id = `resumeSessionId ?? webId`，集中在 `getCcSessionId`。

## 不做

- 真 cc binary 集成 test（B11 方案 a，CI 阻塞，user 决定暂不做）
- manager.ts spawn lock key 抽 helper（surface area 控制）
- command / env / scrollbackBytes 等其它 spawn opts 字段抽 helper

## 范围估算

| 模块 | LOC |
|---|---|
| resume-args.ts | ~20 |
| resume-args.test.ts | ~60 |
| sessions-resume.ts (改) | ~5 |
| **总** | **~85 LOC** |

## Commit 边界

单笔 commit `feat(server): m-resume-args-helper — buildResumeArgs 纯函数`。

## 关联

- 出处：BACKLOG B11（m-session-persistence P7 / P8 feedback）
- 不影响其它 in-flight change
