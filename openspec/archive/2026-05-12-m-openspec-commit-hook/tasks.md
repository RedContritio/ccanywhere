# Tasks: m-openspec-commit-hook (shipped 2026-05-12)

- [x] T1. `.husky/commit-msg` 写 hook（src/web detection + spec detection + reject）
- [x] T2. chmod +x
- [x] T3. 5 case 自测（code-only reject / code+spec accept / test-only reject /
  marker reject / spec-only accept）
- [x] T4. CLAUDE.md "工具层硬约束" 段更新（去掉旧 override 描述）
- [x] T5. archive

## 后续（如出现 friction）

- [ ] 如果某些路径误伤（如 `src/types.d.ts` 内部 type-only 拷贝、build
  meta 等），考虑路径白名单
- [ ] 如果用户反馈 OpenSpec 改动颗粒太碎（每次为了过 hook 都加一行 BACKLOG），
  评估是否引入 `[skip-openspec]` 限定 marker（但需要严格使用规则）

## Commits

- (no matching commits found in git log)
