# Tasks: m-opensource-prep-p2

## C1. README Node >= 20 + macOS-only 显式标 (P2.2)

- [x] T1.1 README ASCII 图之后 + "## 跟同类的差异" 之前加 "##
      Prerequisites" 段 (macOS only / Node>=20 / pnpm 11+ workspaces)
- [x] T1.2 验证: pnpm lint:md 过
- [x] T1.3 commit C1 — `7d5b064`

## C2. Dependabot config (P2.1)

- [x] T2.1 新建 `.github/dependabot.yml` 3 entry:
  - npm root (weekly 周一 06:00 Asia/Shanghai, limit 5, group minor+patch)
  - npm /web (同上 schedule, prefix `deps(web)` 区分)
  - github-actions root (limit 3, prefix `ci`)
- [x] T2.2 验证: grep `^  - package-ecosystem:` 命中 3 (= 3 entry).
      55 行, 1161 bytes. (GitHub 启用后会真正 lint, 本地仅 structure check)
- [x] T2.3 commit C2 — `7a19917`

## C3. README monorepo 结构说明 (P2.3)

- [x] T3.1 README "## 关键文件" 段顶部加 2 行说明: root 是 server +
      CLI (src/), web/ 是 React 前端子 workspace, pnpm-workspace.yaml
      定义, 跑 web 命令用 `pnpm -F ccanywhere-web ...`.
- [x] T3.2 验证: pnpm lint:md 过
- [x] T3.3 commit C3 — `8d84deb`

## C4. Ship

- [x] T4.1 形式化保证: README grep "macOS"(L21) + "Node.js >= 20"(L23)
      + "pnpm-workspace"(L25,L109) 都命中. `.github/dependabot.yml`
      exists (1161 bytes). pnpm lint:md 过.
- [x] T4.2 mv openspec/changes/m-opensource-prep-p2 →
      openspec/archive/2026-05-20-m-opensource-prep-p2
- [x] T4.3 commit C4 archive + 前 3 笔 hash 回填 (T1.3 7d5b064 /
      T2.3 7a19917 / T3.3 8d84deb)
