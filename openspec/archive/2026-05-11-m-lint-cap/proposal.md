# Proposal: M-lint-cap — 文件大小硬上限 + precommit 强制

## Intent

引入 `max-lines` 硬上限避免文件无限膨胀，作为 precommit 强制。

阈值由 codebase 现状 + 用户决策得出，分类应用：

| 类别 | 阈值 | 现状最大 | Why |
|---|---|---|---|
| `src/**/*.ts`（源码） | **300** | 389 (manager) | 推动 store / handler 拆分 |
| `src/**/*.test.ts` | **500** | 723 (server.test) | 测试天然多 case，宽容 |
| `web/src/**/*.{ts,tsx}` | **500** | 935 (terminal) | 含真组件化重构空间 |
| `docs/**/*.md`、`README.md` | **300** | 467 (deployment) | 普通文档简洁 |
| `openspec/**/*.md` | **600** | 805 (web-frontend.spec) | spec / proposal 是 single-source-of-truth，连贯性 > 短小 |

## 违规清单（启用前需清理）

| 文件 | 现状 | 阈值 | 拆分策略 |
|---|---|---|---|
| `src/session/manager.ts` | 389 | 300 | 提 PTY lifecycle / scrollback bridge 子模块 |
| `src/devices/store.ts` | 361 | 300 | 提 persistence helper（load/persist 序列化层） |
| `src/ws/server.ts` | 318 | 300 | 挤 18 行（合并相邻 helper / 移内联注释） |
| `src/server/server.test.ts` | 723 | 500 | 按 capability 拆 server.auth/feedback/spa.test.ts |
| `web/src/components/terminal.tsx` | 935 | 500 | 真组件化：提 useTerminalConnection hook + TerminalHeader 子组件 |
| `docs/deployment.md` | 467 | 300 | §拆为 deployment.md (主) + deployment-staging.md |
| `openspec/specs/web-frontend/spec.md` | 805 | 600 | 按 sub-capability 拆 sub-spec，主 spec.md 保留 cross-cutting + 索引 |

合计 7 文件，估 ~1000 LOC redistribution + ~200 LOC 新 helper / sub-spec 索引等。

## ESLint 配置改动

`eslint.config.js`（flat config，已存在）加 `max-lines` per-pattern override：

```js
const MAX_LINES_OPTS = { skipBlankLines: false, skipComments: false };

{
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.test.ts'],
  rules: { 'max-lines': ['error', { max: 300, ...MAX_LINES_OPTS }] },
},
{
  files: ['src/**/*.test.ts'],
  rules: { 'max-lines': ['error', { max: 500, ...MAX_LINES_OPTS }] },
},
```

web 子 pnpm workspace（`web/`）需查现有 eslint config，同手法加 `web/src/**` → 500 override。如 web 子 package 暂未用 ESLint，本 task 引入最小配置 + 仅装 max-lines 检查。

## md 行数检查（无新依赖）

ESLint 不原生支持 md。新 `scripts/check-md-lines.mjs`：
- 输入：staged md 文件列表（precommit 由 git diff --cached 给出）
- 按 path pattern 应用阈值（`openspec/**` → 600；其余 → 300）
- 超阈值 exit 1 + 列违规 file:line

不引入 markdownlint 或类似工具，避免新依赖。

## Precommit hook 选型

| 方案 | 优 | 劣 |
|---|---|---|
| **husky + lint-staged** | 主流 / IDE 集成成熟 / 社区文档丰富 | 多 2 个 dev 依赖 + `prepare` script |
| **simple-git-hooks** | 单依赖 / 启动快（无 shim 包装） | 社区小 / 不支持 staged-only 增量检查 |

**推荐 husky + lint-staged**，与 typescript-eslint 生态对齐。

precommit 调用：
```
.husky/pre-commit:
  pnpm lint && pnpm lint:md
```

`pnpm lint:md` 调用 `node scripts/check-md-lines.mjs`。lint-staged 仅在大 commit 时优化（暂可不接，先全量 lint）。

## 推进顺序

1. 本 proposal + tasks user 拍板
2. **Phase 1 工具链**（独立、不依赖拆分）：ESLint max-lines + md script + precommit hook
3. **Phase 2 拆分**：7 文件按 phase 推进（src 代码 / src 测试 / web / md）
4. **Phase 3 enable + 验证**：全量 lint 跑通，precommit 真实 trigger 验证

每 phase 一个或多个 commit，按"每个逻辑单元一个 commit"原则。

## 与其他 task 关联

- **#44 M-multi-user 实施**暂停，待 m-lint-cap ship 后续做。chunk 1 已写但 untracked 的 `src/users/`、`src/tokens/` 文件均符合 300/500 阈值，不阻塞 lint task。
- **#43 m-staging-env**已 ship（48ae0a8），不影响本 task。
- 后续涉及现有大文件改动（如 #44 改 `src/devices/store.ts` 加 userId）将受 300 上限约束 → 推动拆分进行。

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 新文件守住阈值 | precommit hook 在 commit 前跑 ESLint + md script |
| 阈值与文件类型匹配 | 4 套 ESLint override (per pattern) + md script 类型分发 |
| 存量违规 0 | 启用 lint 前先拆完 7 文件 |
| openspec md exempt 普通阈值 | `openspec/**` 独立 600 阈值（spec 与 proposal 长期 carve-out） |
| dist / node_modules / coverage 不参与 | ESLint config 现有 ignores 段保留 |
| 自动生成代码（如 future codegen） | 加 `eslint-disable max-lines` 注释或 ignores pattern（约定） |
