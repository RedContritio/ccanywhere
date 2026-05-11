# Backlog（轻量级未启动 task 索引）

集中维护**小项**（≤80 LOC，单笔可做完）。大项各自有 `openspec/changes/
<slug>/`。已 ship 全部进 `openspec/archive/<date>-<slug>/`。

新决策出现新 backlog 项时立即在这里 append（不要靠"我记"）。

启动某项时把它从这里删，转到 `openspec/changes/<slug>/`（即便很小也建
proposal，统一流程）。

---

## 真实 bug（fix 类）

### B1. stale session id 在 URL 的 UX

- **症状**：URL 含 `/workspace/<S>` 但 sessions list 没 S（已删 / 过期）。
  当前裸"session 不在列表中"提示 UX 差。
- **scope**：~30 LOC。workspace.tsx 检测 stale id → friendly banner +
  "回到 /" 按钮 / 或自动 navigate `/workspace`。
- **出处**：feedback `2026-05-09T09-23-34Z-d2a906cf`
- **优先级**：高（影响日常打开 URL 体验）

---

## 体验增强 / polish

### B2. build sha + version 进 diag

- **scope**：~15 LOC。vite config 用 `define` 注入 `__CC_VERSION__`（build
  时 git rev-parse），collectDiag 加 `diag.app.version`。
- **价值**：feedback triage 直接知道是哪个 commit。
- **出处**：`openspec/archive/2026-05-12-m-diag-enrich-v2/tasks.md` "未做"
- **优先级**：中

### B3. user kind 进 diag

- **scope**：~30 LOC。mount 时 fetch `/api/me/quota` (or `/api/auth/me`)
  拿 `kind`，注入 `diag.app.userKind`。要小心 async 与现有同步 collectDiag
  路径，可在 mount 时单独 set 而非 collect 时 fetch。
- **价值**：triage 知道是 owner / limited 报的。
- **出处**：同 B2
- **优先级**：中（与 B2 一笔合并 ship 更顺）

### B4. /settings 独立 page

- **scope**：~80 LOC。route `/settings` + page 容器 + 复用 toolbar edit
  dialog 内容 + 未来扩主题同步 / 字号 / 通知偏好等。
- **背景**：m-user-prefs D2 决策当时用户答"后续单独开一个设置页面，**或者**
  就和主页相关"，我做了 dialog 没做 page。未来加更多偏好就会撞上。
- **优先级**：低（dialog 够用），但记录避免遗忘

---

## E2E / CI

### B5. CI 集成 e2e

- **scope**：~60 LOC + GitHub Actions workflow。需用户先定 self-hosted
  runner 还是 cloud（internal RPC 是 loopback-only，cloud runner 拿不到
  token）。
- **出处**：`openspec/archive/2026-05-12-m-e2e-backbone/tasks.md` "后续"
- **优先级**：低

### B6. e2e 多 browser

- **scope**：~10 LOC。playwright.config.ts 加 webkit / firefox project。
- **出处**：同 B5
- **优先级**：低

---

## 维护类 / 不做但记录

### B7. quota pricing auto-sync

- **scope**：~50 LOC。pricing.ts 改 cached lookup（每周拉一次 Anthropic
  价格表或第三方 npm 包）。
- **背景**：当前硬编码 model → USD-per-token，改价 / 新 model 时过期。
- **出处**：`openspec/archive/2026-05-11-m-quota-cost-tracking/proposal.md`
  "不做" 段
- **优先级**：低（手动跟够用）

### B8. dialog 类组件系统化审核 autoFocus

- **scope**：~10 LOC 审核 + 修。
- **背景**：feedback dialog + new-session dialog 已删 autoFocus；其它
  dialog 类组件（quota panel / 未来设置 dialog 等）应同样审核避免 mobile
  tap 问题。
- **优先级**：低（按需，新 dialog 写时记得即可）

### B9. archive hygiene 决策记录

- **scope**：~5 LOC（archive 一段 readme）。
- **背景**：早期 archive 大量 unchecked `[ ]` 实际已 ship 但没勾。当前
  决策"不清理"（B），用更准的 grep 逻辑（找显式"未做"段），下次新
  conversation 看到 200 条 unchecked 不困惑。
- **优先级**：可选，主要是记录决策本身

---

## 大项（在 `openspec/changes/<slug>/`，本表只列出处指针）

- **m-share-static-export**（v1+，~600 LOC）— programmatic jsonl→HTML
  导出。`changes/m-share-static-export/`
- **m-toolbar-presets**（~80 LOC）— 内置 toolbar 模板 + swap。
  `changes/m-toolbar-presets/`
- **m-touch-scroll-one-line**（~50 LOC，blocked-on-data）— 偶发滑动一行
  bug。`changes/m-touch-scroll-one-line/`
- **m-fit-cols-off-by-one**（in-flight，blocked-on-data）— Phase 1 trace
  已 ship；等用户反馈触发 Phase 2/3。`changes/m-fit-cols-off-by-one/`
