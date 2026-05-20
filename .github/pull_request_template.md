<!--
首次贡献者请先看 CONTRIBUTING.md (OpenSpec 流程 / dev setup / commit
风格)。本模板帮助 reviewer 快速定位 PR 改动 + 验证。
-->

## 描述

<!-- 一句话讲改动是什么 -->

## OpenSpec reference

<!--
链接到 openspec/changes/<slug>/proposal.md 或 BACKLOG 条目。
小项 (≤80 LOC) 可只引用 BACKLOG 条目;大项必须有 proposal/tasks。
-->

`openspec/changes/<slug>/proposal.md`

## 改动类型

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Documentation
- [ ] Build / tooling

## 验证

- [ ] `pnpm typecheck:all` 过
- [ ] `pnpm lint` 过
- [ ] `pnpm lint:md` 过
- [ ] `pnpm test` 过
- [ ] 新增 / 修改的行为有对应测试

## 相关 issue

<!-- 用 `Closes #N` / `Fixes #N` -->
