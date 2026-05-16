---
status: in-flight
---

# Proposal: m-archive-commit-backfill — archive tasks.md commit hash 回填

## Intent

CLAUDE.md "tasks.md 关联 commit hash（ship 时回填）"——抽 archive 样本
（m-share-export-cleanup / m-logout-preserve-pairing / m-nav-restructure-
globals / m-auth-routes-split / ...）发现没有任何 archive 在 tasks.md
里写 commit hash。slug 与 commit 的关联只能靠 `git log --grep`，查询便利
缺失。

加一个 ~50 行 scripts/backfill-archive-commits.mjs，扫 archive 目录、对
每个 slug `git log --grep` 找匹配 commit、追加 `## Commits` 段到 tasks.md
末尾。Idempotent：已有 `## Commits` 段跳过该 archive。一次性回填 50 个
archive；后续手工 ship 流程可考虑同流程，但脚本本身可独立运行。

## 决策

### D1. 用 `## Commits` heading，不与现有 `## Ship` 段冲突

调研：50 个 archive 中 7 个手写了 `## Ship` 段，含义是 build/deploy/
commit 最后步骤 checkbox 清单（非 hash 列表）。BACKLOG B16 原描述 "在
tasks.md 末追加 `## Ship\n- <hash>: <msg>`" 会语义冲突。改用独立
heading `## Commits`，与现有 `## Ship` 共存不冲突。

### D2. Prefix-safe 匹配

`git log --grep=<slug>` 是 regex 包含匹配。会把 `m-auth` 的查询匹到
`m-auth-routes-split` 的 commit。post-filter：subject 中 slug 出现位置
后面字符必须不是 `[a-zA-Z0-9-]`（即非 slug 延续字符，是 boundary token）。
这样 `m-auth` 不会误匹 `m-auth-routes-split:` 的 commit。

### D3. Idempotent

每次跑前检查 tasks.md 是否已有 `^## Commits` heading（startOfLine
match）。已有 → 跳过，不重复追加。

### D4. 输出格式

```
## Commits

- <short-hash> <subject>
- <short-hash> <subject>
```

按 `git log` 默认顺序（newest first，与 timeline 一致）。如果脚本找不到
任何匹配 commit，输出 `- (no matching commits found in git log)`——保留
heading 让 reader 知道脚本跑过、不是漏。

### D5. 不做自动 ship-time hook

本次只做"一次性回填脚本"。后续 ship 流程是否每次手工跑这个脚本、还是
集成进 commit-msg hook，留独立讨论（hook 化要考虑 amend 场景的循环
更新问题）。

## 落地点

| 文件 | 改动 |
|---|---|
| `scripts/backfill-archive-commits.mjs` (新) | ~50 行 Node ESM；扫 `openspec/archive/*/`、对每 slug `git log --all --grep` + prefix-safe filter、追加 `## Commits` 段 |
| `openspec/archive/<date>-<slug>/tasks.md` × N | append `## Commits` 段（仅当无该段且至少有一个候选 commit） |

执行：`node scripts/backfill-archive-commits.mjs` 一次性回填全部 archive；
脚本输出每个 archive 的处理结果（追加 / 已有 / 无匹配）。

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| Idempotent | 已有 `^## Commits` heading 的 archive 跳过 |
| Prefix-safe | slug 在 commit subject 中后跟非 `[a-zA-Z0-9-]` 才算匹配，排除 `m-auth` vs `m-auth-routes-split` 误匹配 |
| 无 commit 也保留 heading | 找不到候选时仍写 `## Commits` + `- (no matching commits found in git log)`，下次跑不会重复尝试 |
| 无 git 副作用 | 脚本只读 git log + 写 tasks.md；不 commit / push / amend |

## 不做

- ship 时自动调脚本的 git hook（独立讨论，amend / cherry-pick 场景复杂）
- 修改 commit message 反向链接 archive 路径（commit message 不可变，已 ship 的不应改）
- BACKLOG 条目自动回填（BACKLOG 在 ship 时已删；archive 段含 "出处" 文字
  关联 BACKLOG 即可）
- 改 CLAUDE.md ship 流程文档（脚本可独立运行；后续是否集成进流程是另一
  个决策）
