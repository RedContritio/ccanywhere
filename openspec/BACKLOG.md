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

（无）

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
