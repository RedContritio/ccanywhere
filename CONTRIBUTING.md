# Contributing to ccanywhere

谢谢有兴趣给 ccanywhere 贡献。项目用 **OpenSpec 工作流** — 任何代码
改动都要伴 spec 文档。本文档说明 dev setup / 工作流 / commit 约定。

## Dev setup

需要:

- macOS (项目是 macOS LaunchAgent only;`node-pty` 原生模块也是)
- Node.js >= 20
- pnpm 11

```bash
git clone https://github.com/RedContritio/ccanywhere
cd ccanywhere
pnpm install

# 验证套
pnpm typecheck:all                  # tsc 校验 root + web
pnpm lint                           # eslint
pnpm lint:md                        # 自定义 md line cap 检查
pnpm test                           # vitest 单测 (server-side)
pnpm -F ccanywhere-web test         # 前端单测
```

playwright e2e (`web/e2e/`) 是 **self-hosted only** (打 prod 实例 + 走
loopback internal RPC mint token),外部 PR 不需要跑。GitHub Actions e2e
workflow 用 `vars.E2E_ENABLED` gate,fork 默认不会触发。

## OpenSpec 工作流

三个目录:

- `openspec/changes/<slug>/{proposal,tasks}.md` — 进行中工作
- `openspec/archive/<YYYY-MM-DD>-<slug>/` — 已完成工作
- `openspec/specs/<area>/spec.md` — 稳定行为契约 (Requirement + Scenario)

### 必跑流程 (新 feature / bugfix)

1. **开工前**: 在 `openspec/changes/<slug>/` 建 `proposal.md` + `tasks.md`
   - proposal 含: **Intent** + **落地点** + **决策**(含候选 + 推荐) +
     **形式化保证** + **不做**
   - tasks 含: 可勾 checkbox + 关联 commit hash (ship 时回填)
2. **改代码** + 勾 tasks 进度
3. **ship 时**: 如果改动影响 spec area,同步 `openspec/specs/<area>/spec.md`
   delta (Requirement + Scenario)
4. **完成后**: `mv openspec/changes/<slug> openspec/archive/<date>-<slug>`
5. **commit message body** 含 archive 路径 + spec delta 摘要

### 小项 / 微调

≤ 80 LOC 的小项不需要建 `changes/` 目录,直接在 `openspec/BACKLOG.md`
append 一条 (含 **出处** / **scope 估算** / **优先级**)。PR commit 引用
BACKLOG 条目即可。

### 例外 (可省 OpenSpec)

- 纯 typo / docs 格式
- 测试代码 only (regression test 等)
- CONTRIBUTING / SECURITY / 模板文件

## Commit message 风格

```
<scope>: <one-line summary>

<paragraph: why + tradeoffs considered>

<per-area or per-file change list>

<verification 摘要 (test 数 / lint / deploy)>
```

约定:

- `<scope>` 通常是当前 epic slug (例如 `m-opensource-prep-p1`)
- summary 用现在时,一句话讲 **what changed**
- body 解释 **why**,不重复 `git diff` 已显示的 what
- 每个 logical change 一个 commit。不 batch 多个独立改动

## Commit-msg hook

`.husky/commit-msg` 检查 `src/` 或 `web/src/` 改动是否伴 `openspec/`
改动。**当前是 warning 模式** (不强制 fail),但维护者 review PR 时
会要求补 OpenSpec touchpoint。推荐你的 commit 一开始就含 OpenSpec
改动 (proposal/tasks/BACKLOG 任一)。

## PR 流程

1. Fork → branch → 改动 + commit (per OpenSpec 流程)
2. 跑完整验证套 (typecheck + lint + lint:md + test) 全过
3. PR 描述引用 `openspec/changes/<slug>/proposal.md` (说明 intent)
4. 维护者 review + merge

## 安全问题

安全漏洞**不要**开 public issue。走 GitHub Private Security Advisory:
<https://github.com/RedContritio/ccanywhere/security/advisories/new>

详见 [SECURITY.md](./SECURITY.md)。

## License

贡献会被视为按 [Apache-2.0](./LICENSE) 提交。
