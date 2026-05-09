# Proposal: M-mobile-spec-realign — 校准 specs 反映已 ship 的 mobile 改造

## Intent

近期连续 ship 的 mobile 大改造（task #27 dims state machine、#30 文本选中复制、
反馈服务端 PTY 全量 trace、renderer 默认从 dom 切 webgl、drawer 加"刷新"
按钮）多数在合并实现 commit `683d8f2` 时未同步把 spec delta merge 回
`openspec/specs/`。结果是 `specs/web-frontend/spec.md` 等仍描述旧契约
（dom 默认 / 无 dims 状态机 / 无文本选中行为）；`fit-timing` archive 中
更是写着 `100lvh`，与最终落定的 `100svh` 矛盾。

本次是纯 doc realign：

- 不改任何代码，不改测试。
- 把 `683d8f2` 之前已 ship 的契约层事实回填到 `specs/`。
- 对 `fit-timing` archive 中提案值与最终落定值不一致的部分（`lvh` →
  `svh`、translate target 从 `.terminal-pane` → `.terminal-pane-content`、
  `terminal-header` 加 `z-index:5` 防 transform stacking context）按
  最终实施落到 specs/，原 archive 内容不动（保留三次反转的决策记录）。
- 加 `sessions` 与 `rest-api` 两侧的 PTY data 分片追踪契约
  （`recentDataChunks` 在 feedback `serverSession` payload 中）。
- 校准 feedback `ops` 上限：spec 里"最多 100 项"过时——服务端 runaway guard
  已经升到 20000，客户端 `MAX_OPS` 由窗口 × 密度 × headroom 推导到 ~6500。

## Scope

### web-frontend/spec.md

- **MODIFY** `Requirement: 终端 renderer 选择策略`：默认 `dom` → `webgl`。
  - canvas addon 上游已 deprecate，SDR 下 atlas race 修不动。
  - dom 路径在密 frame（cc TUI 全屏重画）下做 ~1500 DOM mutations/paint，
    mobile 主线程 stall 30-80ms，60fps 不可达。
  - webgl 在 `term.dispose()` 顺序梳理后不再触发 `_isDisposed` race
    （AddonManager 自己链式 dispose，外部不再手动 dispose addon）。
  - URL `?renderer=dom|canvas|webgl` 仍 MAY override，仍不持久化。
- **ADD** `Requirement: 客户端尺寸生命周期（dims state machine）`：从
  `archive/2026-05-09-m-mobile-fit-timing/specs/web-frontend/spec.md`
  落到 specs/，内容与 archive 一致。
- **ADD** `Requirement: 终端 mount 期间显示 placeholder`：同上。
- **ADD** `Requirement: 软键盘视觉上移`：来自 fit-timing archive 的
  `软键盘 visual viewport 跟随`，但本次落到 specs/ 时按最终实施修订：
  - CSS 锚定 `100lvh` → `100svh`（small viewport，URL bar / 键盘事件
    都不触发 ResizeObserver；`lvh` 在 URL bar 显示状态超出 viewport）。
  - `transform: translateY(-keyboardH)` target 从 `.terminal-pane` →
    `.terminal-pane-content`，让 `.terminal-header` 留在原 layout 位置，
    键盘弹起时 header 不跟随上移。
  - `keyboardH = layoutH - vv.height - vv.offsetTop`（iOS Safari 与
    Android Chrome resizes-visual 路径通用）。
  - `.terminal-header` / `.workspace-header` MUST 显式 `position: relative;
    z-index: 5` —— `transform` 在 `.terminal-pane-content` 上隐式建
    stacking context，否则视觉上 `terminal-pane-content` 覆盖
    `terminal-header`（dogfood 反馈"top bar 不停住"实证）。
  - viewport meta MUST NOT 含 `interactive-widget=resizes-content`——保持
    浏览器默认 `resizes-visual`（让 layout viewport 不缩、visual viewport 缩，
    `100svh` 锚定才有意义）。
- **ADD** `Requirement: 终端文本选择与触摸滚动接管`：来自 task #30。
  - touch 三态机 `idle | scroll | selection`（mutex）。
  - long-press 500ms 进 selection（Android `ViewConfiguration.getLong
    PressTimeout()=500ms` + iOS `UILongPressGestureRecognizer.minimum
    PressDuration=0.5s` 对齐 OS muscle memory）。
  - tap-slop 6 px 触发 scroll（Android tap slop 8 dp / Material 8 dp /
    Hammer.js 10 px 偏紧；下限 ~5 px 是手指自然抖动）。
  - 容器上挂 capture-phase `touchstart`/`touchmove`，`stopImmediate
    Propagation` 接管 xterm 5 内部 `Terminal.ts:835` 的 touchmove
    listener（其改 `_viewportElement.scrollTop` 并按 `round` 量化导致
    每帧 ±1 行的"翻一行"bug）。
  - self-driven scroll：`dyAccum / cellHeight` 取整调 `term.scrollLines`，
    余数累积。`cellHeight = fontSize × VISUAL_LINE_HEIGHT_FACTOR (1.2)`
    （monospace TUI 业界 line-height 默认；不耦合 xterm 内部 cell pitch）。
  - selection 进入路径：`dispatchMouseEvent('mousedown', x, y)` 让 xterm
    selection service 接管；touchend 后 `getSelection()` →
    `navigator.clipboard.writeText(text)`。
- **MODIFY** `Requirement: 用户反馈渠道`：drawer 底部除"反馈"外加
  "刷新"按钮，调 `location.reload()`。临时缓解 cc Ink scrollback 重复行
  （详见 task #33 与 anthropics/claude-code#49086 上游 issue），不替代
  正在跟踪的上游修复。

### sessions/spec.md

- **ADD** `Requirement: PTY data 分片追踪`：
  - `Session` 接口新增 `lastDataAt: number | null`、`exitCode: number | null`、
    `recentDataChunks: readonly PtyDataChunkRecord[]`。
  - `PtyDataChunkRecord = { ts: number; len: number; head: string }`，
    `head` 是 chunk 前 32 字节的 hex-escaped（控制字节展开为 `\xNN`）。
  - 每次 PTY `onData` MUST append 一条记录；`recentDataChunks` 是
    append-only 数组，session 生命周期内不裁剪（exit + GC 后随 session
    实例释放）。
  - 用途仅限诊断：让 feedback record 中的 `serverSession.recentDataChunks`
    与客户端 `diag.term.screen` / `ops` trace 对位还原 cc 输出时序。
  - 内存：cc idle 状态约 10 chunks/s × ~100 B 元数据 = ~5 MB/小时；
    长寿 session 可在数据写入处按 byte cap 裁剪（不影响契约语义）。

### rest-api/spec.md

- **MODIFY** `Requirement: POST /api/feedback`：
  - 请求 body `ops` 上限说法："最多 100 项" → "上限 N，由客户端 `MAX_OPS`
    决定（窗口 × 密度 × headroom 推导，当前 ~6500）。服务端只设 runaway
    guard 20000，超过返 400"。
  - `serverSession` 字段表加 `recentDataChunks: PtyDataChunkRecord[]`，
    含两个 sub-scenario（命中 / 不命中）说明该字段只在 session 命中时存在。

## Out of scope

- 不动 `fit-timing` archive（保留 lvh 的历史决策与三次反转记录）。
- 不写新代码、不改测试。
- task #28 M-ws-init-state-gating（output 帧先于 snapshot）独立处理。
- task #34 M-design-system-unify（设计语言统一）独立处理。
- task #33 M-cc-scrollback-leak-track（cc upstream Ink bug 跟踪）独立处理。

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| specs/ 描述与 ship 现状一致 | 本次 delta 直接对位 `683d8f2` commit 的契约层改动 |
| archive 内部决策记录不丢 | 不动 archive，仅在 specs/ 写最终值，并在本 proposal 标注差异 |
| 后续新工作仍按完整流程走 | 本次是 realign 而非新 design，scope 锁死在 doc patch |
