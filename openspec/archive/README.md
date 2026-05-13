# Archive — 已 ship change 历史

本目录每个子目录 `<YYYY-MM-DD>-<slug>/` 含一对 `proposal.md` + `tasks.md`，
代表一个**已 ship**的 change（feature / bugfix / refactor）。slug 与
`changes/` 内的目录名保持一致；ship 时 `mv changes/<slug>
archive/<date>-<slug>`。

## ⚠ Unchecked `[ ]` 不代表 todo

早期 archive 大量 unchecked `[ ]` 实际已 ship 但当时没勾。决策："不
清理"——回头补勾 35 个 archive × 多步 task 是 archeology 工作，commit
hash 在 git log 可查，但人工对应回来不值。

新 archive (≥ 2026-05-13) 已实践 archive 前回填：所有 ship 的 task
勾上 `[x]` + 末尾附 commit hash。但旧 archive 不回填。

## 寻找未做 backlog 时

**不**数 archive 的 unchecked。看：

- `openspec/BACKLOG.md`：未启动小项（≤ 80 LOC，单笔可做完）
- `openspec/changes/<slug>/`：进行中或计划中的大项
- 每个 archived proposal 的 "**不做**" / "**Level 2/3 follow-up**" 段：
  显式列出"当时决定不做但留作后续"的范围

显式"未做"段是真信号；scattered `[ ]` 是噪声。grep 模式：

```bash
# Look for explicitly deferred work (signal)
rg "^## (不做|后续 BACKLOG|follow-up)|未做|Level 2" openspec/archive/

# Not this — noise from old archives
rg "^- \[ \]" openspec/archive/   # ❌
```

## 出处

- 决策来自 BACKLOG B9（archived 2026-05-13 as
  `m-archive-hygiene-readme`）
