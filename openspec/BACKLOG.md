# Backlog（轻量级未启动 task 索引）

集中维护**小项**（≤80 LOC，单笔可做完）。大项各自有 `openspec/changes/
<slug>/`。已 ship 全部进 `openspec/archive/<date>-<slug>/`。

新决策出现新 backlog 项时立即在这里 append（不要靠"我记"）。

启动某项时把它从这里删，转到 `openspec/changes/<slug>/`（即便很小也建
proposal，统一流程）。

---

## 真实 bug（fix 类）

### B26. listHistory path mismatch (shared-container resume / project history list)

- **状态**：**已修** (m-host-credentials-share branch).
- **现象**：user 反馈 "不断在 test 创建新对话, 但只有一个历史对话".
  e2e shared-container 有 12 jsonl 历史 sessions 在
  `<userClaudeRoot>/e2e/projects/-workspace-e2e-test/`, 但 ccanywhere
  `/api/projects/:id/history` 只读 owner home (homedir/.claude/
  projects/-Users-...-e2e-test/, dir 不存在) → 永远空 / 显仅一条.
- **root cause**：跟 B24 (QuotaWatcher) 同 path mismatch. listHistory(
  cwd, historyRoot) 默认 cwd=host path encode + historyRoot=homedir/
  .claude. shared-container user 实际写 dir 完全不同.
- **fix**：projects.ts + sessions.ts caller 加 effectiveHistoryArgs
  helper, 当 user runtime='shared-container' 时 translate host cwd →
  container cwd (D9 amendment 路径) + 把 historyRoot 切到
  `<userClaudeRoot>/<user>/projects/`. legacy host runtime user 走默
  认 homedir 路径不变 (零回归).
- **scope**：~70 LOC src + projects.ts + sessions.ts wire 改 + server.ts
  透传 userClaudeRoot/containerDeps 进 ProjectRoutesOptions +
  SessionRoutesOptions. 627/627 full test pass.

### B25. xterm `_isDisposed` undefined on cleanup (React StrictMode 双调)

- **状态**：**已修** (m-host-credentials-share branch).
- **现象**：feedback ops 看到 `terminal.dispose.error: Cannot read
  properties of undefined (reading '_isDisposed')`. React StrictMode
  dev mode 双调 useEffect cleanup, xterm.js 5.x `term.dispose()` 不
  idempotent, 第二次 access internal `_core._isDisposed` 时 undefined
  抛错.
- **fix**：terminal.tsx cleanup body 头加 `let cleanedUp = false;
  if (cleanedUp) return; cleanedUp = true;` flag guard. 整个 cleanup
  真 idempotent — 第二次直接 return, 不重跑 disposers / dispose().
- **scope**：~5 LOC.

### P10c. container cc 颜色 — TERM/COLORTERM env inject

- **状态**：**已修** (m-host-credentials-share branch).
- **背景**：user 反馈 e2e cc 的 logo 从 orange 变 red. 误认为是 per-user
  config share, 实际是 web xterm 颜色渲染.
- **root cause**：docker exec 默认 TERM=xterm (16-color), 没 COLORTERM.
  cc binary 看 COLORTERM 决定 truecolor / 256 / 16. 退回 16-color
  ANSI palette → brand orange 映射成 ANSI red (`\\x1b[31m`).
- **fix**：session-runtime overlay env 加 `TERM=xterm-256color` +
  `COLORTERM=truecolor`. cc 输出 24-bit RGB, xterm.js 渲染正确.

### P10b. user-scope settings.json seed — per-user cc preference 持久

- **状态**：**已修** (m-host-credentials-share branch).
- **背景**：P10 v2 commit `d399e39` 撤回 baked user-scope settings.json
  cp (managed scope 替代 deny rules) — 但 user-scope settings.json
  file 本身也被撤掉. user 报 "cc 用户配置没有了 / 跨 user 看着像
  share 同一份" — 实际是 cc 用 default theme/preference, 看着相同.
- **fix**：ContainerUserSync.ensureUser 在 mkdir per-user dir 之后,
  `sh -c '[ -f ... ] || (echo "{}" > ... && chown + chmod)'` 创空
  user-scope settings.json. 不 overwrite (existing user `/theme` 改
  的内容保留), idempotent. cc 下次启动 read 同 file write theme 等
  user preference, 改动 persist 跨 spawn (mount 出 host 持久化).
- **scope**：~12 LOC ContainerUserSync + 1 test 改 + 1 test 加 seed
  assert. 10/10 user-sync tests pass.

### P11 (reserved). cc `!` shell escape 绕过 managed deny

- **状态**：架构限制, 当前 cc binary 设计层防不住. 标 reserved 等
  anthropic 政策 / cc binary 改动.
- **现象**：user 在 cc interactive UI 输入 `!cmd` (例 `!env`) 触发
  cc binary 的 shell escape mode, **不经 permission tool layer**.
  managed-settings.json `permissions.deny` 仅约束 LLM-initiated tool
  calls; `!` mode 是 user-direct shell input.
- **根本原因**：cc binary 设计上让 user 有 quick shell access. cc
  process env 含 CLAUDE_CODE_OAUTH_TOKEN (D10 必须), cc spawn bash
  子进程 (`!` 触发) 时 bash 继承 env, user 跑 env / printenv 直接
  print token.
- **D6 trust model 接受**：shared-container 假设 user = owner alt
  account, user 自愿 leak 自己 owner token 不算 attack.
- **真不可信 user 用例**：需 `m-user-isolated-container` (per-user
  真隔离 VM / token 不进容器). 复杂方案, anthropic 政策仍约束.
- **anthropic 一旦提供** `disableShellMode` 或类似 managed 字段 →
  立刻加进 managed-settings.json.

### P10. permission deny pattern + LLM soft norm 实测

- **状态**：**已实施** (m-host-credentials-share branch, **Full Managed
  scope**). 完全不占 user-level dir — `/etc/claude-code/managed-
  settings.json` 同时含 `permissions.deny` rules + `claudeMd` field
  (LLM soft norm 文本 inline as JSON string) + `allowManagedPermission
  RulesOnly: true`. ContainerUserSync 撤回 cp CLAUDE.md/settings.json
  进 per-user dir; cc binary 直接 read `/etc/claude-code/`. 实测 user
  在 per-user `.claude/settings.json` 加 `allow: ["Bash(node -e *)"]`
  仍被 cc refuse — managed precedence (Managed > Local > Project >
  User) + `allowManagedPermissionRulesOnly` enforce.
  shipped 进 `archive/2026-05-20-m-host-credentials-share/spike-
  results.md` 详记 7 个 attack vectors + 已知 bypass.
- **scope**：docker/settings.json deny rules 加 interpreter eval
  patterns (node -e / python -c / sh -c / bash -c / etc) + /proc
  read patterns (head/tail/strings/grep/sed). CLAUDE.md soft norm
  扩写 token export attack vectors 列表 + trust model 解释.
- **后续 (reserved)**: Medium 强度 (network egress 锁仅 anthropic),
  Heavy 强度 (Bash 白名单), sidecar daemon (复杂度高 + 仍 third-
  party). user 选 Light 接受 sophisticated attacker 绕过.

### B24. QuotaWatcher 对 shared-container 新 session race (projects dir missing)

- **状态**：**已修** (m-host-credentials-share branch). 根本原因不是
  dir race 而是 path encoding mismatch — watcher 用 host cwd
  (`/Users/.../e2e/test`) encode 得 `-Users-...`, 但 container 内 cc
  用 mount 后 cwd (`/workspace/e2e/test`) encode 得 `-workspace-...`,
  watcher 永远监错 dir. 修法: watcher 加 `hostWorkspace` +
  `containerWorkspacePath` opts, shared-container path 时 translate
  host cwd → container cwd 再 ccJsonlPathOf. 新 test cover.
- **scope**：~30-50 LOC
- **背景**：QuotaWatcher.start 在 session spawn 时 check `<userClaudeRoot>/
  <user>/projects/<encoded-cwd>/` 是否存在, missing 就 skip + warn.
  ContainerUserSync.ensureUser 创了 `<userClaudeRoot>/<user>/` 但
  没预创 `projects/<encoded-cwd>/` 子目录 — cc spawn 后才晚创, 那时
  watcher 已 skip 不会 retry. 结果 e2e dogfood spawn 后 jsonl 真落
  + cc 真扣 anthropic quota, 但 ccanywhere UserStore tokens=0/limit
  (B24 confirmed: jsonl `usage.input_tokens` + cache + output 总
  ~16k tokens, store 显示 0).
- **修法候选**：
  - **a. ContainerUserSync 预创 projects/`<encoded-cwd>/`**: 但
    `<encoded-cwd>` 是 spawn time 决定的, ensureUser 是 user-creation
    time (不知 cwd). 要把 mkdir 移到 session-runtime overlay
    或者 sessions.ts spawn 前.
  - **b. QuotaWatcher 加 retry on missing**: 监 parent dir
    (`<userClaudeRoot>/<user>/projects/`), 子 dir 出现时 attach. ~20
    LOC + 处理 fs.watch 平台差异.
  - **c. fs.watch recursive (host-only mac/linux dual)**: 简洁但
    macOS recursive 仅 file 不 dir create event.
- **出处**：m-host-credentials-share D10 ship 验证 (2026-05-20).

- **状态**：待决策（讨论 sidebar 该显 session 还是 project）
- **scope**：~20-50 LOC，依方案
- **背景**：主页 `/workspace` 显 user 所有 projects（GET /api/projects），
  sidebar (`WorkspaceSidebarContent`) 显的是 SessionList（仅有 session
  的 project）。用户预期 sidebar 显**所有 projects** + 折叠显示其下
  sessions。e2e dogfood 反馈 2026-05-19T12-06-20 "主页显示三个项目，
  sidebar 只有一个"。
- **方案候选**：
  - **a. sidebar 改成 project list + 折叠 sessions**（重构）：sidebar
    顶层 = projects，子层 = sessions（树形）。`SessionList` 改名 +
    重写 ~50 LOC。
  - **b. 主页改成 session list**（极简）：主页不显 projects 卡片，
    显 sessions 入口（active + dead）— 但用户没有 session 时主页空。
    ~10 LOC。
  - **c. sidebar 加 "新建" 按钮列出所有 projects 让用户选**（最小）：
    sidebar 维持现状显 sessions，"新建" 弹 project 选择 list。已有
    `newDialogOpen` flow，~5 LOC 调。
- **出处**：e2e dogfood 反馈 2026-05-19T12-06-20。

### B22. sidebar header label fallback 误用 token plaintext

- **状态**：已修 (commit on `m-shared-container-workspace-fix`)
- **scope**：~10 LOC，单笔
- **背景**：`web/src/pages/login.tsx` `tryToken(t, fallbackUsername)`
  实现 happy path 用 `me.label`（server 返 username），fallback path
  错把第二参数 `fallbackUsername` 当 `setLimitedSession`'s `username`
  传 — caller 传的恰好是 token plaintext (`tryToken(t, t)`)。结果
  sidebar header chip 显完整 token 字符串 (~64 hex)，影响视觉 + 是
  secret leak 隐患。
- **fix**：probeSession 失败时 fallback 用 `result.user.username`
  （/api/auth/token 服务端返的 username）当 label；删 `fallbackUsername`
  param。token plaintext 不再出现在 label store path 上。
- **出处**：e2e dogfood 反馈 2026-05-19T07-39-22。

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
