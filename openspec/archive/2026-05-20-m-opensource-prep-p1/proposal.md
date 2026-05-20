# Proposal: m-opensource-prep-p1 — 开源前 P1 准备(README + 治理文件 + hook 放宽)

## Intent

P0 (m-opensource-prep + audit-fix) 已完成 license + 脱敏. 本 epic 处理
P1 — 影响外部贡献者第一印象 / 上手门槛的事项. 范围:

- **README 重写** — 现是内部进度报告, 对外无定位
- **CONTRIBUTING.md** — 解释 OpenSpec 流程, 否则外部 PR 被 commit-msg
  hook 拦得一头雾水
- **SECURITY.md** — WebAuthn + PTY-exposing 项目必备披露 channel
- **commit-msg hook 放宽** — 现在硬拦所有 src 改动没 openspec/, 外部 PR
  改个 typo 都被拦
- **README badges** — license / Node / CI status, 一眼信号
- **Issue / PR template** — 引导 issue 格式
- **docs DNS provider 通用化** — 腾讯云 DNSPod 改成可选示例之一
- **e2e workflow README 说明** — self-hosted only 注明

## 落地点 + 决策

### D1. README 重写

候选范围:
- **A** (推荐): 完整重写顶部 — 1 段定位 + 安全模型 + 跟同类对比 +
  quick-start 简化. 保留"关键文件"/"测试"/"文档"/"设计原则"段
- **B**: 只重写顶部段(去掉 M1-M7 状态), 其他不动. 更轻

决策点:
- 跟谁对比? 候选: ttyd(纯 web TUI) / Tailscale+SSH(网络层私网) /
  VSCode tunnel(类比) / claudia(同生态 GUI)
- 加 demo screenshot / GIF?

### D2. CONTRIBUTING.md 范围

候选:
- **A** (推荐): OpenSpec 流程 + dev setup (clone/install/test/lint) +
  commit message 风格
- **B**: 只 OpenSpec 流程, 其他指向 README

### D3. SECURITY.md disclosure channel

候选:
- **A** (推荐): GitHub Private Security Advisory (现代默认, 不需要暴露
  邮箱, 流程标准化)
- **B**: 个人邮箱(user 私域邮箱不再放仓库 — 这条排除)
- **C**: 邮件 alias (例如 security@your-domain) 转 user

### D4. commit-msg hook 放宽策略

当前硬拦:src/ 或 web/src/ 改动没 openspec/ 直接 exit 1.

候选:
- **A** (推荐): 改 warning — 仍输出提示但不拦. fork PR 不会被拦, 维护者
  自己 commit 时看到提示自我约束
- **B**: 只对 main 分支强制 — 外部 PR 在 fork 分支 OK, merge 时再检查
- **C**: 完全删 hook — 软约束

### D5-D8 (mechanical, 默认方案不需要 review)

- D5: README badges — license + Node + CI(ci.yml only, 不 e2e self-hosted)
- D6: `.github/ISSUE_TEMPLATE/{bug.yml, feature.yml}` + `pull_request_template.md`
- D7: `docs/deployment-frpc.md` 加一段总览注明 acme.sh 支持的 DNS provider
  list, 保留 DNSPod 作详细 example
- D8: `.github/workflows/e2e.yml` 顶部加一段 README-style 注释(已有了)
  同步 root README 一句话注明 e2e 是 self-hosted only

## 形式化保证

- README 顶部不再出现 "M1–M7 全部就绪" / "148 测试" 等内部进度叙述
- `grep -rn "redcontritio\|recoco\.xyz"` 在新增的所有 P1 文件(CONTRIBUTING
  /SECURITY/templates) 0 命中
- husky hook 改 warning 后: 故意 commit src/ 改动没 openspec/, 应该
  输出 warning 但 commit 成功
- pnpm lint:md 全过

## Phases

- **C1**: README 重写(含 badges D5) — 最大改动, 单独 phase
- **C2**: CONTRIBUTING.md (D2)
- **C3**: SECURITY.md (D3)
- **C4**: commit-msg hook 放宽 (D4) — 改 .husky/commit-msg
- **C5**: ISSUE / PR templates (D6)
- **C6**: docs/deployment-frpc.md DNS provider 通用化 (D7)
- **C7**: e2e workflow README 注明 (D8)
- **C8**: Ship — archive + hash 回填

每个 C 单独 commit. C1 含 README badges (D5) 一起做, 因为 badges 在
README 顶部, 不另开 phase.

## 不做(P2 留待后续)

- Dependabot / Renovate config
- README Node >=20 + macOS-only 显式标注(quick-start 里隐含, 不单列)
- monorepo 结构说明(已 README 提一句够)
- git history squash(等所有 P1 + P2 后再 squash)
