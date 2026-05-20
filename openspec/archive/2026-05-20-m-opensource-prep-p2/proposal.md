# Proposal: m-opensource-prep-p2 — README prerequisites + Dependabot + monorepo 说明

## Intent

P0/P1 完成后剩余 P2 项. 不阻塞公开, 但加上后外部上手体验更好.

按 user 选定顺序: P2.2 → P2.1 → P2.3 → (P2.4 单独讨论).

## 落地点

### C1. README Node >= 20 + macOS-only 显式标 (P2.2)

CONTRIBUTING.md 已经写"macOS only / Node >= 20", 但 README 顶部没显式标.
外部 Linux/Win 用户 clone 后跑 `pnpm install` 才发现 `node-pty` 原生
编译失败, 体验差.

落地: README intro 段后加一段 prerequisites (3 行):
- macOS only (LaunchAgent + node-pty 原生模块)
- Node.js >= 20
- pnpm 11+ (workspaces)

### C2. `.github/dependabot.yml` (P2.1)

config:
- npm ecosystem: 周一周更 root + web 两个 workspace
- github-actions ecosystem: 周一周更 .github/workflows
- 默认 PR 数 limit 5 防 PR flood
- assignee 设作者 RedContritio

不上 Renovate (需要额外的 GitHub App install + config repo, Dependabot
是 GitHub native 零配置门槛).

### C3. README monorepo 结构说明 (P2.3)

README 加一段说明 `pnpm-workspace.yaml` + root / web sub-workspace
结构, 让外部贡献者一眼明白 `pnpm -F ccanywhere-web ...` 是什么.

## 决策

- **D1**: prerequisites 段位置 — README intro 之后 + 同类对比之前.
  原因: 外部读者看完 intro 知道 ccanywhere 是什么后, 立即看到能不能
  用 (OS / Node). 同类对比在后才有意义.
- **D2**: Dependabot vs Renovate — 选 Dependabot (GitHub native, 零
  config repo, 维护成本低).
- **D3**: monorepo 说明放 README 哪里? — 加到 "## 关键文件" 段顶部
  一句话引出, 避免单独开新 section.

## 形式化保证

- README 含 "macOS" + "Node >= 20" 字串 (新加 prerequisites 段)
- `.github/dependabot.yml` exists + YAML valid
- README 含 "pnpm-workspace" 引用

## Phases

- **C1**: README prerequisites (P2.2)
- **C2**: Dependabot config (P2.1)
- **C3**: README monorepo 说明 (P2.3)
- **C4**: Ship — archive + hash 回填

P2.4 (git history squash) 单独讨论, 不在本 epic.

## 不做

- Renovate (用 Dependabot 替代)
- README 完整 i18n EN 版 (社区反应后再说)
- CHANGELOG / semantic-release (lib 才需要)
