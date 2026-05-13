---
status: shipped
shipped_at: 2026-05-12
---

# Proposal: m-ci-e2e — GitHub Actions CI setup

## Intent

Repo 没有 CI workflow，所有 typecheck / lint / test / build / e2e
都靠本机跑。引入 GitHub Actions 让 PR / push 自动 gate 静态检查与
unit 测试。e2e (playwright visual) 因 internal RPC 是 loopback-only
+ webauthn 不能走 cloud runner，单独走 self-hosted runner 并 var
gate 启用。

## 决策摘要

D1. **拆两个 workflow file**：
    - `ci.yml` — static gates (typecheck/lint/unit/build) on cloud
      ubuntu-latest，每次 push/PR 触发
    - `e2e.yml` — playwright visual on self-hosted macOS runner，仅
      `vars.E2E_ENABLED == 'true'` 时触发
    单一文件混跑会让 cloud job 拖累 self-hosted 调试或反之；分开
    pipeline clear。

D2. **cloud vs self-hosted 边界**：
    - cloud (ubuntu-latest) 跑：typecheck / eslint / lint:md / vitest
      (root 315 + web 132) / build:all
    - self-hosted (macOS, ccanywhere label) 跑：playwright e2e
      (visual + smoke)
    cloud runner 拿不到 ccanywhere loopback RPC（mint e2e token）和
    prod webauthn cookie 资源，e2e 在 cloud 无法完成。BACKLOG B5 提
    及此约束。

D3. **e2e 默认 dormant**：repo var `E2E_ENABLED` 缺失 / 非 'true'
    时 job skip。这样 PR 阶段不会因 e2e runner 未注册而 pending /
    fail。user 决定启用时：
    - 在 mac (跑 ccanywhere serve 的那台) 注册 self-hosted runner
      with labels `[self-hosted, macOS, ccanywhere]`
    - 在 repo settings → Variables 加 `E2E_ENABLED=true`

D4. **e2e job 加 upload-artifact on failure**：失败时上传
    `web/test-results/`（含 visual-*.png 截图 + trace.zip），让
    triage 不需要 ssh runner 找截图。

D5. **pnpm version 11 + node 20**：node 20 满足 engines `>=20`；pnpm
    11 与本机 11.0.8 同 major（engines 段不约束 pnpm）。

## 落地点

- `.github/workflows/ci.yml`（新）— 30 行 static gate
- `.github/workflows/e2e.yml`（新）— 50 行 self-hosted e2e（dormant）

## 形式化保证

F1. PR / push 到 main 时 ci.yml 100% 跑（无 conditional gate）。
F2. e2e.yml 在 `E2E_ENABLED != 'true'` 时整 job skip，runner unavailable
    不会让 PR pending。
F3. e2e 失败时 screenshot + trace 自动上传，triage 不需 ssh runner。

## 不做

- 不写 release / publish workflow（不在 B5 范围）
- 不引 docker / containerized e2e（self-hosted mac 已经是 cc 运行
  环境，docker 化反而复杂）
- 不引 Slack / email 通知（GitHub 自带 PR check status 够用）
- 不在 cloud runner 上 mock ccanywhere server 跑 e2e（mock 偏离真实
  环境，BACKLOG B5 已论证 prod 域名 + frpc + 真 webauthn 是 e2e 核心
  价值）

## 范围

- ci.yml ~30 LOC
- e2e.yml ~50 LOC
- 共 ~80 LOC（与 BACKLOG B5 估算 60 LOC 接近）

## 关联

- 出处：BACKLOG B5；m-e2e-backbone archive 提及后续 CI 集成
- 不阻塞 m-design-system-unify ship（visual e2e 在本机已经跑过）

## 启用 e2e job 的 user runbook

1. 在 mac (host of `ccanywhere serve`) `~/actions-runner/` 安装
   GitHub Actions runner（按 repo settings → Actions → Runners 提示
   的 token + url 走完 `./config.sh`）
2. 配 labels：`self-hosted`, `macOS`, `ccanywhere`
3. 启动 runner（`./run.sh` 或 launchd plist，按官方文档）
4. repo settings → Secrets and variables → Actions → Variables 加
   `E2E_ENABLED = true`
5. 下次 push 触发 e2e job
