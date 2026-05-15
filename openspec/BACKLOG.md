# Backlog（轻量级未启动 task 索引）

集中维护**小项**（≤80 LOC，单笔可做完）。大项各自有 `openspec/changes/
<slug>/`。已 ship 全部进 `openspec/archive/<date>-<slug>/`。

新决策出现新 backlog 项时立即在这里 append（不要靠"我记"）。

启动某项时把它从这里删，转到 `openspec/changes/<slug>/`（即便很小也建
proposal，统一流程）。

---

## 真实 bug（fix 类）

（无）

---

## 体验增强 / polish

（无）

---

## E2E / CI

（无）

---

## 维护类 / 不做但记录

### B14. routes/auth.ts 拆三段（webauthn / multi-user / session-mgmt）

- **状态**：deferred（ROI 边际，仅 ~0 LOC 净减，可读性边际提升）
- **scope**：~0 LOC 净（290 行 → 三个 ~100 行文件 + 1 个共享 helper）
- **背景**：`src/server/routes/auth.ts` 290 行含 5 个 webauthn 路由 +
  multi-user mount + logout + me。每段 30-50 行带 zod schema，密度合理
  但单文件长。
- **触发信号**：下次大改 auth（例如加 passkey resident credential 或
  webauthn level 3 conditional UI）时顺手做
- **出处**：本评审 A4

### B16. archive commit hash 回填脚本

- **状态**：低优先（cheap polish）
- **scope**：~30 LOC scripts/backfill-archive-commits.mjs + 一次性扫
- **背景**：CLAUDE.md 写 "tasks.md 关联 commit hash（ship 时回填）"
  但抽 m-share-export-cleanup / m-logout-preserve-pairing / m-nav-
  restructure-globals 等最新 archive 的 tasks.md，commit hash 字段空。
  commit subject 含 slug，git log grep slug 能定位，所以信息没丢只是
  查询便利。
- **方案**：scripts/backfill-archive-commits.mjs 扫
  `openspec/archive/<date>-<slug>/`，grep slug 在 `git log` 出现的
  commits，在 tasks.md 末追加 `## Ship\n- <hash>: <msg>`。
- **出处**：本评审 C3

---

## Deferred（触发条件未到 — 等真实信号再启动）

下面这些条目都已有完整 scope + 决策点 + 出处。但触发条件（user 实际抱怨
/ 量级达到痛阈值）尚未到，启动是浪费。本段是"显式 deferred 而非遗忘"
的可见队列——下次扫 BACKLOG 看到这段就跳过，除非有新信号。

### B12. Level 2 scrollback 持久化

- **状态**：deferred（"最后一屏已能定位上下文"基线尚未被 user 抱怨突破）
- **触发信号**：user 进 dead pane 抱怨"想看历史滚动找不到"
- **scope**：~150 LOC（dead 时 scrollback 全文 → 单独 file；resume 时 feed
  回 xterm 还原；存储格式与 screen.txt 共享路径）
- **背景**：m-session-persistence Level 1 只持久化"最后一屏"（含 ANSI
  alt-screen + cursor 位置），dead pane 看不到历史滚动。Level 2 把
  scrollback ring buffer 全文落盘，user 进 dead session 能滚回看历史
- **决策点**：scrollback 大小（默认 1024 行 ~50-200 KB）/ format
  （raw ANSI 还是 plain text）/ 是否压缩
- **出处**：m-session-persistence proposal D8 "不做" 段标记 follow-up

### B17. login.tsx useLoginMode state machine hook

- **状态**：deferred（触发条件未到）
- **scope**：~60 LOC（抽 `useLoginMode()` hook 集中 8-kind Mode
  discriminated union 状态机）
- **背景**：`web/src/pages/login.tsx:20-29` 定义 8 kind Mode union，
  `:42` setMode 在 11 处直接调用。已经把 IdleChoices 拆出来了（说明
  作者愿意拆）。下次加新 mode（如 SSO / OAuth）时顺手抽。
- **触发信号**：第三种登录方式被引入（当前仅 webauthn + token）
- **出处**：本评审 B2

### B13. dead session retention policy

- **状态**：deferred（单 owner + ~10 limited e2e user，dead 数量远未到累积痛阈值）
- **触发信号**：boot 扫 sessions/ 慢 / 占盘超过痛阈值 / share 功能 ship 后 multi-user 累积
- **scope**：~80 LOC + config schema bump
- **背景**：m-session-persistence D11 决定 dead session 无自动 GC——user
  不主动删就永远留。长期 N 大用户会累积 N 个 `<id>.json` + `.screen.txt`
  慢 boot 扫描 + 占盘。可选 retention：超 N 天 / total size 超 M MB
  时按 LRU hard delete dead stub
- **决策点**：默认 ttl（7d / 30d / 永不）/ 是否进 config schema /
  loadDeadStubs 时机做不做 size-based prune
- **风险**：config schema bump = prod 同步成本（参考 m-multi-user
  `guestProjectsRoot` 教训）
- **出处**：m-session-persistence proposal D11 + "不做" 段

---

## 大项（在 `openspec/changes/<slug>/`，本表只列出处指针）

- **m-toolbar-presets**（~80 LOC）— 内置 toolbar 模板 + swap。
  `changes/m-toolbar-presets/`
- **m-touch-scroll-one-line**（~50 LOC，blocked-on-data）— 偶发滑动一行
  bug。`changes/m-touch-scroll-one-line/`
- **m-fit-cols-off-by-one**（in-flight，blocked-on-data）— Phase 1 trace
  已 ship；等用户反馈触发 Phase 2/3。`changes/m-fit-cols-off-by-one/`
- **m-write-queue-extract**（~80 LOC）— 抽 share/store + session/registry
  公共 WriteQueue helper，删 50 LOC 重复。`changes/m-write-queue-extract/`
- **m-store-zod-load**（~70 LOC）— share/store + session/registry 加载
  JSON 改用 zod schema + 公共 loadJsonRecord helper。`changes/m-store-zod-load/`
- **m-webauthn-routes-test**（~150 LOC 测试新增）— 覆盖 webauthn 5 路由
  的信封 + 状态机 + mock verify 后行为（happy 真签名留 e2e）。
  `changes/m-webauthn-routes-test/`
- **m-workspace-page-split**（~150 LOC 主文件减）— workspace.tsx 488
  行拆 useWorkspaceRouting hook + WorkspaceMainPane + WorkspaceSidebar
  Header 子组件。`changes/m-workspace-page-split/`
- **m-new-session-dialog-steps**（~120 LOC 主文件减）— NewSessionDialog
  411 行拆 Step1ProjectPicker + Step2HistoryPicker 受控子组件。
  `changes/m-new-session-dialog-steps/`
- **m-diag-collectors-split**（~100 LOC 重排）— diag.ts collectDiag 156
  行单函数拆 8 个内部 collector，主函数变 ~25 行 composition。
  `changes/m-diag-collectors-split/`
