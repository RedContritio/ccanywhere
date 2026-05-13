---
status: planned
---

# Proposal: m-archive-hygiene-readme — archive/ 加 README 记录"不清理"决策

## Intent

BACKLOG B9：早期 archive 大量 unchecked `[ ]` 实际已 ship 但没勾。当前
决策"不清理"（cleanup 是 archeology 工作 + 不值的回头成本）。但新
conversation 看到 archive 200+ `[ ]` 会困惑——以为还有工作未做。

加 `openspec/archive/README.md` 一次性记录这条决策 + 推荐"找显式『未
做』段而不是数 unchecked"的 grep 模式。

## 决策

D1. **不回头清理早期 archive**：35 个 archive 都是 ship-done state；
    回头补勾每条 tasks.md 是 archeology 工作（commit hash 还在 git log
    可查，但人工对应回来 30+ archive × 多步 task 不值）。

D2. **README 一次性写清**：未来人（包括 LLM agent）看到 unchecked
    `[ ]` 时去 README 看决策，不再问。

D3. **未来标准**：新 archive 必须把已 ship 的 tasks 全勾上（已在
    m-design-system-unify / m-session-persistence Phase 7 实践——
    archive 时回填 commit hash + 勾上漏勾 task）。

## 落地点

**新**：`openspec/archive/README.md` (~30 LOC)

## 形式化保证

F1. 早期 archive (≤ 2026-05-12) 的 unchecked `[ ]` MUST 被视为 "已 ship
    但当时未勾"，不代表 todo。
F2. 新 archive (≥ 2026-05-13) MUST archive 前回填所有已 ship 的 task
    `[x]` + commit hash。
F3. 寻找未做 backlog 时 MUST 走 `openspec/BACKLOG.md` + `openspec/
    changes/`，不数 archive unchecked。

## 不做

- 不回头补勾 35 个 archive 的 unchecked tasks
- 不引 automation / lint 拦未来 archive 漏勾（人工纪律）

## 范围估算

| 模块 | LOC |
|---|---|
| archive/README.md | ~30 |
| **总** | **~30 LOC** |

## Commit 边界

单笔 commit `docs(openspec): m-archive-hygiene-readme — archive/ README
记录"不清理"决策 (B9)`。

## 关联

- 出处：BACKLOG B9
