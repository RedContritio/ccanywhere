# Tasks: m-opensource-prep-audit-fix

## C1. sed 替换 + 验证

- [x] T1.1 `sed -i '' 's/ccanywhere\.example\.com/cc.example.com/g'`
      跑 README.md / docs/deployment.md / examples/config.json /
      openspec/specs/config/spec.md (4 文件 / 5 行)
- [x] T1.2 `sed -i '' 's|/Users/you/\.local|/Users/<you>/.local|g'`
      跑 docs/deployment.md (1 行)
- [x] T1.3 验证: grep `ccanywhere\.example\.com` 在 archive 之外 0
      命中. grep `/Users/you/` 0 命中. pnpm lint:md 过.
- [x] T1.4 commit C1 — `9db718f`

## C2. Ship

- [x] T2.1 mv openspec/changes/m-opensource-prep-audit-fix →
      openspec/archive/2026-05-20-m-opensource-prep-audit-fix
- [x] T2.2 commit C2 archive + T1.4 hash 回填
