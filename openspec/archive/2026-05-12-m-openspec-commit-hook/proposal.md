# Proposal: m-openspec-commit-hook — commit-msg hook 强制 openspec 改动

## Intent

把"代码改动必须同笔含 OpenSpec 改动"从 CLAUDE.md 软约定升级为
**git commit-msg hook** 硬约束。

## Why

CLAUDE.md 规则靠"我守纪律 + 用户监督"——多个 round 实际证明会漏（详
见上一笔 `ba75cec` commit message 里列的 5 类漏项）。Edit 工具的
"must-Read-first" 是 harness 强制的硬约束，绕不过。OpenSpec 完整性需要
对应级别的硬约束。

## 设计

`.husky/commit-msg` hook 检查暂存区：

- 任一 staged 文件匹配 `^(src/|web/src/)` → "code changed"
- 任一 staged 文件匹配 `^openspec/` → "spec changed"
- code changed 且 not spec changed → exit 1，输出 actionable 错误

**无 override**：
- 不接受 `[skip-openspec]` 之类的 message marker
- 不豁免 test-only diff
- 不豁免注释 / refactor

任何代码改动都要在同笔 commit 触一个 OpenSpec 文件——哪怕只是 tasks.md
打勾 / BACKLOG.md 一行说明 / archive proposal 末尾追一段。

## 验证

5 case 自测：

| case | scenario | expected | actual |
|---|---|---|---|
| A | code-only | reject | ✓ |
| B | code + openspec | accept | ✓ |
| C | test-only file | reject | ✓ |
| D | `[skip-openspec]` marker | reject | ✓ |
| E | openspec-only | accept | ✓ |

## 形式化保证

| 性质 | 机制 |
|---|---|
| 代码与 OpenSpec 不漂移 | commit-msg hook 单 atomic check |
| 无 backdoor | 删 `[skip-openspec]` + 删 test-only 豁免 |
| 容易理解 | 单文件 ~40 LOC shell；逻辑 = "code changed + spec not changed → reject" |
| pre-commit / pre-push 路径不冲突 | commit-msg hook 跟现有 pre-commit (`pnpm lint`) 串行；不相互拦 |

## 落地

- `.husky/commit-msg` （新文件，shell script，可执行）
- CLAUDE.md "工具层硬约束" 段更新
- 本 archive 记录决策

## 不做

- 不做 GitHub Action 服务端 enforcement（本地 hook 已足；CI 失败可以 retry）
- 不做特例豁免清单（用户明确要求"不允许跳过"）
- 不做 commit-msg body 必须含 archive path 的额外校验（避免过度规范）

## 历史教训

CLAUDE.md 之前几段都是软约定累积：
- "memory 不维护 backlog"
- "未启动项必须落 OpenSpec"
- "spec drift 同步"

每一条都有过被 bypass 的例子（详见 `ba75cec` audit "漏项审计"段）。
工具化是唯一可靠路径。本笔不解决"memory 软约定" — 那需要不同机制
（hook 不能查 memory）。但 OpenSpec 路径硬化是最大单笔收益。
