# Proposal: m-opensource-prep — 仓库开源准备(license + 个人信息脱敏)

## Intent

把 ccanywhere 从"野蛮内部开发"状态推到可公开的开源仓库。本 proposal
覆盖**法律 + 个人信息**两件事:

1. 加 LICENSE / 完善 package.json 元数据 → 法律层可用
2. 全仓清掉私域名 / 私人邮箱 / 个人 user 名 / 个人路径 → 不泄漏

不覆盖的(留给独立 proposal):

- README 改写(P1 — 现状是内部 milestone 进度记录,对外不构成定位)
- CONTRIBUTING / SECURITY / ISSUE_TEMPLATE(P1 — 治理文件)
- CLAUDE.md 拆分(P1 — user 私域工作流应移出仓库)
- husky commit-msg hook 对外部贡献者放宽(P1)
- git history squash(P2 — 看 ship 时机决定)

## 已落地(本分支已含 working-tree 改动)

- `LICENSE` — Apache-2.0 canonical 文本(从 apache.org curl,
  SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`)
  + 末尾追加 `Copyright 2026 RedContritio`
- `package.json` — 删 `"private": true`,加 `license` / `author` /
  `repository` / `bugs` / `homepage`(指向 `github.com/RedContritio/ccanywhere`)
- `README.md` — 末尾 License 段从「(待补)」改成「Apache-2.0. See LICENSE.」

## 决策(license 部分,已定)

- **License**: Apache-2.0
  - hard requirement: permissive(允许商用 / 闭源衍生 / SaaS) + 含
    专利反制条款(§3 任何对贡献者发起专利诉讼者立即丧失专利授权) +
    强 attribution(§4 NOTICE / LICENSE 必须随发行物分发)
  - 符合这三条的 permissive license 只有 Apache-2.0
- **Copyright holder**: RedContritio(git ID,与 GitHub 帐号一致)
- **NOTICE 文件**: 不要(个人项目没特别声明需要)
- **License 文本来源**: apache.org canonical(不手写,避免 SPDX
  detector 识别失败)

## 决策(脱敏部分,已定)

- **D1**: `scripts/cert-issue.sh` 删 `DOMAIN` / `EMAIL` 默认值。
  未 export 时 exit 2 报错"必须 export `CCANYWHERE_DOMAIN` /
  `CCANYWHERE_ACME_EMAIL`"。语义明确:这俩是必须配置项,无默认。
- **D2**: e2e fallback 改 `throw new Error('CCANYWHERE_TEST_URL must be set')`。
  覆盖 `web/playwright.config.ts:19` + `web/e2e/smoke.spec.ts:76` +
  `web/e2e/global-setup.ts:165` 三处。外部 fork 跑 e2e 必须配 URL,
  绝不误打 prod 域。
- **D3**: `src/config/loader.test.ts:121,124` 用 `os.tmpdir()` 动态
  生成测试路径。最鲁棒,不暗示 OS / 不假设文件系统布局。
- **D4**: `README.md:9` 拓扑图 `recoco.xyz` → `cc.example.com`。
- **D5**: CLAUDE.md 整体移出仓库 (`git rm --cached` + `.gitignore`),
  working tree 副本保留. 改自原 D5.B "整段移出 CLAUDE.md" 中途 push
  back — user 提出 "有些内容是正确的, 还不如把 claude.md 移除出去".
  原计划只删私域 L72-139 三节但保留 L1-70 OpenSpec 流程, user 反对
  因为: (1) 私域三节(本机部署/prod config/schema bump) user 本人仍
  在用,删了 user 自己以后没参考;(2) 留在公开仓库语义模糊 — 项目通用
  规则(OpenSpec 流程)应该作为正式 CONTRIBUTING.md(P1),不应混在
  CLAUDE.md 私域文件里. 整体 untrack 比删段更干净. 本地副本 user 自己
  cp 到 `~/.claude/projects/<encoded-cwd>/CLAUDE.md` 让 claude code
  per-project 自动加载, 或别处. OpenSpec 流程那部分留给 P1 CONTRIBUTING.md
  正式化.
- **D6**: openspec/archive 10 个文件全量清扫:
  - `recoco.xyz` → `example.com`(`cc.recoco.xyz` → `cc.example.com`)
  - `redcontritio` → `<you>`(覆盖 `/Users/redcontritio/...` /
    `com.redcontritio.ccanywhere` 等所有用法)
  - 用 `sed -i ''` 一次性替换

## 形式化保证

- 全仓 `grep -rn -E "(redcontritio|recoco\.xyz)" --include=...` 在
  src / web / scripts / docs / examples / README / CLAUDE.md 范围
  内**零命中**(openspec/archive 不算)。
- 全仓 `grep -rn "/Users/[a-z]"` 在 src / web 范围内**仅命中明确
  占位符**(`/Users/<you>`)。

## Phases

按 commit 就绪边界拆分:

- **C1**(已落,待 commit): license + package.json + README license 段
- **C2**: `scripts/cert-issue.sh` 删默认值(D1)
- **C3**: e2e fallback throw 三处(D2)
- **C4**: `loader.test.ts` 用 `os.tmpdir()`(D3)
- **C5**: README 拓扑图 `recoco.xyz` → `cc.example.com`(D4)
- **C6**: CLAUDE.md 删 L72-139 私域三节(D5)
- **C7**: openspec/archive 10 文件 sed 替换(D6)
- **C8**: ship — 归档 proposal + 同步 spec(如有 area 影响)

每个 C 单独 commit。C2-C7 互不依赖,顺序 commit 便于 review。

## 不做

- README 重写(P1)
- 治理文件(CONTRIBUTING / SECURITY / ISSUE_TEMPLATE)(P1)
- husky commit-msg hook 放宽(P1)
- git history squash(P2)
