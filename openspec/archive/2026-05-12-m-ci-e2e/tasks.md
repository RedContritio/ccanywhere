# Tasks: m-ci-e2e

- [x] T1. `.github/workflows/ci.yml`（新）— ubuntu-latest + pnpm 11 +
  node 20 + typecheck:all + lint + lint:md + test:all + build:all
- [x] T2. `.github/workflows/e2e.yml`（新）— self-hosted macOS
  runner + playwright visual + upload-artifact on failure；vars.
  E2E_ENABLED 'true' 时启用
- [x] T3. workflow yaml 本地 lint 检查（actionlint 不在依赖中，
  靠 GitHub Actions 解析时验，无 local lint）
- [x] T4. archive proposal 含 user runbook（如何启用 e2e job）
- [x] T5. 删 BACKLOG.md B5 段
