# Tasks

## 段 1：脚本

- [ ] T1.1 新建 `scripts/backfill-archive-commits.mjs`
- [ ] T1.2 扫 `openspec/archive/*/`，从 dir 名 `^\d{4}-\d{2}-\d{2}-` 之后提 slug
- [ ] T1.3 对每个 slug：`git log --all --format='%h %s' --grep=<slug>`；post-filter prefix-safe（slug 后必须是非 `[a-zA-Z0-9-]`）
- [ ] T1.4 读 `tasks.md`：已有 `^## Commits` heading 则跳过；否则 append `## Commits\n\n- <hash> <subject>\n...`（无候选时写 `- (no matching commits found in git log)`）
- [ ] T1.5 stdout 报告每 archive 处理结果（追加 / 已有 / 无匹配）

## 段 2：执行回填

- [ ] T2.1 `node scripts/backfill-archive-commits.mjs` 一次性回填
- [ ] T2.2 git diff 抽样确认 5 个 archive 的 `## Commits` 段合理

## 段 3：BACKLOG + Commit + Archive

- [ ] T3.1 `openspec/BACKLOG.md` 删 B16 条目
- [ ] T3.2 commit（含 archive 路径，无 spec delta）
- [ ] T3.3 `mv openspec/changes/m-archive-commit-backfill openspec/archive/<date>-m-archive-commit-backfill`
