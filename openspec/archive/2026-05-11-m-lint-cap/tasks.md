# Tasks: M-lint-cap

整体 design 见 `proposal.md`。

阈值速查：`src/**/*.ts` 300 / `src/**/*.test.ts` 500 / `web/src/**` 500 / 普通 md 300 / `openspec/**` md 600。

---

## Phase 1: 工具链（独立，不依赖拆分）

- [ ] T1. `eslint.config.js` 加 `max-lines` per-pattern override：
  - `src/**/*.ts` 排除 `*.test.ts` → 300
  - `src/**/*.test.ts` → 500
  - 选项：`skipBlankLines: false, skipComments: false`
- [ ] T2. 查 `web/` 子 package 现有 eslint config；如存在加 `web/src/**` → 500 override；如不存在引入最小 ESLint config 仅装 max-lines
- [ ] T3. 新建 `scripts/check-md-lines.mjs`：
  - 输入：argv 或 git diff --cached 列出的 md 文件
  - 按 path pattern 应用阈值（`openspec/**` → 600；其余 → 300）
  - 超阈值 exit 1 + 列违规 `file:line`
- [ ] T4. `package.json` 加 script：`"lint:md": "node scripts/check-md-lines.mjs"`
- [ ] T5. 装 husky + lint-staged：
  - `pnpm add -D husky lint-staged`
  - `pnpm prepare` script 加 `husky` install
  - `.husky/pre-commit` 内容：`pnpm lint && pnpm lint:md`
- [ ] T6. 验证 phase 1：手动 commit 一个空白改动，precommit 触发 → lint 跑过（含存量 7 个违规暂时 fail，需 phase 2 修复）。临时 disable 7 个文件的 max-lines（用文件级 `eslint-disable max-lines` + md 文件由 script 临时 skip），让 lint pass

## Phase 2: src/ 代码拆分

- [ ] T7. `src/session/manager.ts` (389) 拆：
  - 抽 PTY 生命周期到 `src/session/lifecycle.ts`
  - 抽 scrollback bridge 到 `src/session/scrollback-bridge.ts`
  - 主 manager.ts 目标 < 300
  - 跑 `vitest run src/session/` 验证不破现有测试
- [ ] T8. `src/devices/store.ts` (361) 拆：
  - 抽 persistence helper（load/persist serializer）到 `src/devices/persist.ts`
  - 主 store.ts 目标 < 300
  - 跑 `vitest run src/devices/` 验证
- [ ] T9. `src/ws/server.ts` (318) 微调：
  - 合并相邻 helper 函数 / 移内联注释
  - 目标 ≤ 300（挤掉 18 行）
  - 跑 `vitest run src/ws/` 验证

## Phase 3: src/ 测试拆分

- [ ] T10. `src/server/server.test.ts` (723) 拆 sub-test by capability：
  - `src/server/server.auth.test.ts` ← cookieName / auth 路径相关 case
  - `src/server/server.feedback.test.ts` ← feedback 路由 case
  - `src/server/server.spa.test.ts` ← SPA fallback / static serving case
  - 主 server.test.ts 保留 build / shutdown / error handler 等 cross-cutting
  - 主目标 < 500
  - 跑 `pnpm test` 全量验证

## Phase 4: web/ 拆分

- [ ] T11. `web/src/components/terminal.tsx` (935) 组件化重构：
  - 提 `useTerminalConnection` hook（ws lifecycle / dead reason / reconnect）到 `web/src/hooks/use-terminal-connection.ts`
  - 提 `TerminalHeader` 子组件到 `web/src/components/terminal-header.tsx`
  - 主 terminal.tsx 目标 < 500
  - LOC 估 ~500 redistribution，真组件化重构（注意 props / state 解耦）
  - 跑 `pnpm -F ccanywhere-web test` 验证

## Phase 5: md 拆分

- [ ] T12. `docs/deployment.md` (467) 按 §拆：
  - 主 `docs/deployment.md` 保留 §1-§4（基础部署）
  - §9 staging 实例 → `docs/deployment-staging.md`
  - 主目标 < 300
- [ ] T13. `openspec/specs/web-frontend/spec.md` (805) 按 sub-capability 拆：
  - 主 spec.md 保留 cross-cutting + sub-spec 索引
  - sub-capability spec → `openspec/specs/web-frontend/<sub>.spec.md`（如 terminal / dialog / theming）
  - 主目标 < 600
  - 验证 openspec lint（如有）通过

## Phase 6: enable + verify

- [ ] T14. 移除 phase 1 临时 disable（删 `eslint-disable max-lines` 注释 + md script skip list）
- [ ] T15. `pnpm lint && pnpm lint:md` 全绿
- [ ] T16. `pnpm typecheck:all` + `pnpm test:all` 全绿
- [ ] T17. precommit hook 真实 trigger 验证：故意写超 300 的 src .ts，git add + commit → 应被 hook 阻断
- [ ] T18. 用户确认 commit

---

## 与 #44 关系

- #44 chunk 1 已写但 untracked 的 `src/users/`、`src/tokens/` 文件（types/store/test）均符合阈值，不阻塞 m-lint-cap。
- m-lint-cap ship 后回到 #44 继续 chunk 2（device store 改造、鉴权改造、CLI、internal API、文档、spec delta）。
- m-lint-cap 完成后 #44 改 `src/devices/store.ts` 加 userId 时，由于 store.ts 已拆到 < 300，加字段后仍守阈值。

## 推进顺序

1. user 拍板本 proposal/tasks
2. Phase 1 工具链（一笔 commit 或两笔：ESLint config / scripts + husky）
3. Phase 2-5 各 phase 独立 commit（按 phase 拆，每 phase 内的多文件可视改动量再细分）
4. Phase 6 enable + verify（一笔 commit）
5. 归档 m-lint-cap 到 `openspec/archive/<date>-m-lint-cap/`
6. 回到 #44 chunk 2
