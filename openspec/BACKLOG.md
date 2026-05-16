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

### B21. share 页面快速导航：滑动条 + 目录 + 回到顶部

- **状态**：待商榷（user 2026-05-16 标 "第二个有待商榷"）—— 启动前必须先 brainstorm 收敛
- **scope**：~unknown，依方案而定（独立讨论）
- **背景**：share 页对话很长（数百到数千行）时缺乏快速导航手段。当前
  只能浏览器滚动条 + cmd-F 搜索。
- **方案候选（待 user 决策）**：
  - **a. 浮动 "回到顶部" 按钮**（最小）：右下角浮动 `↑`，scroll > N
    时 fade-in；点击 scrollTo({top: 0, behavior: 'smooth'})。~30 LOC
  - **b. 快速滑动条**（中）：右侧固定 mini-scrollbar 显示文档进度 +
    drag 跳跃，类似 vscode minimap。~80-120 LOC
  - **c. 目录导航**（大）：解析对话结构（user / assistant turn 分段）
    生成 TOC sidebar，点击跳到对应 turn。~150-200 LOC，需要 share
    导出时保留 turn 结构标记
- **决策点**：a 是最小快赢，b 是体验中等增量，c 改 share export 格式
  影响范围大。是 a / b / c 单做 还是组合
- **出处**：2026-05-16 user dogfood

（原小项已清空，B19 archive abandoned + B14/16/18 ship + 上批 #2 ship）

---

## E2E / CI

（无）

---

## 维护类 / 不做但记录

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

### B36. `components/` 平铺切 feature 子目录

- **状态**：deferred（触发阈未到）
- **触发信号**：`components/` 突破 50 production files（当前 33 production + 13 test = 46，刚好低于阈值）
- **scope**：~40 LOC 估算（实际改 imports 工作量 ~200 LOC scale）
- **方案**：建 `components/workspace/ / session/ / terminal/ / share/ / quota/ / toolbar/ / common/` 子目录，原文件按 feature 归类，grep 全 import path 改一遍
- **不做理由（2026-05-17 评估后 defer）**：触发阈未到，提前重构无 ROI；实际 import path 改动 scope 远超 ~40 LOC 估算；到 50 真痛点再启动
- **出处**：2026-05-17 subagent 评审 2 §2

### B37. React 18.3 → 19、Vite 5.4 → 6 dep bump

- **状态**：deferred（稳定优先于追新）
- **触发信号**：明确新功能需要 React 19 API（Server Components 不适用 ccanywhere；useFormStatus / useOptimistic 可能用例）
- **scope**：~50 LOC dep bump + 跑全套 e2e 回归
- **方案**：bump package.json + 跑 typecheck/test/e2e + 验证 xterm/radix lifecycle
- **不做理由（2026-05-17 评估后 defer）**：React 19 useTransition/Suspense API 行为差异 + concurrent rendering 默认变化，需要回归 xterm.js (dispose timing) + radix (focus trap) 完整 e2e；当前 React 18.3 + Vite 5.4 stable 跑得好，无触发信号
- **出处**：2026-05-17 subagent 评审 2 §8

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
  决策点未定（preset 数量 / 自定义保存）。`changes/m-toolbar-presets/`
- **m-touch-scroll-one-line**（~50 LOC，blocked-on-data）— 偶发滑动一行
  bug。`changes/m-touch-scroll-one-line/`
- **m-fit-cols-off-by-one**（in-flight，blocked-on-data）— Phase 1 trace
  已 ship；等用户反馈触发 Phase 2/3。`changes/m-fit-cols-off-by-one/`
