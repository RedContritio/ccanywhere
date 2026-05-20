# Contributing to ccanywhere

谢谢有兴趣给 ccanywhere 贡献。本文档说明 dev setup / PR 流程 / commit
约定。

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

## Commit message 风格

```
<scope>: <one-line summary>

<paragraph: why + tradeoffs>

<per-area or per-file change list>

<verification 摘要 (test 数 / lint / deploy)>
```

约定:

- `<scope>` 通常是受影响的模块或主题 (例如 `session`, `web/ws`, `docs`)
- summary 用现在时,一句话讲 **what changed**
- body 解释 **why**,不重复 `git diff` 已显示的 what
- 每个 logical change 一个 commit。不 batch 多个独立改动

## PR 流程

1. Fork → branch → 改动 + commit
2. 跑完整验证套 (typecheck + lint + lint:md + test) 全过
3. PR 描述说清 intent + 改动列表 + 验证
4. 维护者 review + merge

PR template 在 `.github/pull_request_template.md` 引导基本字段。

## 安全问题

安全漏洞**不要**开 public issue。走 GitHub Private Security Advisory:
<https://github.com/RedContritio/ccanywhere/security/advisories/new>

详见 [SECURITY.md](./SECURITY.md)。

## License

贡献会被视为按 [Apache-2.0](./LICENSE) 提交。
