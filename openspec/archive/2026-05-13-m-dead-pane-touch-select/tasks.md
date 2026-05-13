# Tasks: m-dead-pane-touch-select (planned)

## Phase 1 — 实现

- [x] T1.1. `web/src/components/terminal-touch.ts`：`fit` 改 optional
  + onTouchStart 2-finger 路径 `if (fit === undefined) return` 跳过
  pinch + onTouchMove `fit?.fit()` 满足 TS
- [x] T1.2. `web/src/components/dead-session-pane.tsx`：import +
  `setupTouchInteraction(container, t, undefined)` after t.open +
  cleanup 时 call handle.cleanup()
- [x] T1.3. typecheck:all / lint / lint:md / test 全过
- [x] T1.4. build:all + kickstart + healthz 200

## Phase 1.5 — Final (feedback 2026-05-13T05-13-19-110Z: "足够 work 了")

- [x] User 确认 P7 修复后 mobile 长按选择稳定工作。要求 final review。
- [x] Final state: P3 (synthetic mouse for long-press) / P4 (transparent
  overlay) / P5 (plain text only) 都被 P6+P7 覆盖，文件无残留。当前
  dead pane 实现 = DOM renderer (P6) + capture-phase mouse* stop (P7)。
  P1+P3 setupTouchInteraction detail 改动 stay (terminal-touch.ts) 给
  active pane defensive 用。P2 mouse-mode reset 移除 (P7 cap stop
  superseded)。
- [x] Final regression: full test (360 passed) + 全 visual e2e (10
  passed incl. mobile iPhone 13) + lint / lint:md / typecheck:all /
  build:all / kickstart healthz 200 全过。
- [x] feedback 2026-05-13T05-13-19-110Z mark-seen
- [x] Doc head dead-session-pane.tsx 更新反映 P7 final state；mobile
  e2e test 名从 "P5 plain-text" 更新为 "P7 DOM renderer + capture-phase
  mouse stop"。

## Phase 1.5 — P7 polish (feedback 2026-05-13T04-45-58-940Z)

- [x] P7. P6 ship 后 user 反馈 "偶尔无法选中" —— P6 大部分时间工作，
  但 race condition signal: sometimes mobile native selection 被 xterm
  内部 listener block。
  - Root cause: xterm SelectionService 注册 mousedown listener 在
    `.xterm` element (Terminal.ts:548)，handler 内显式调
    `event.preventDefault()` (SelectionService.ts:467) "Tell the
    browser not to start a regular selection" 来 favor xterm 自己的
    canvas-overlay selection。P6 解锁了 user-select 但没切断这个
    preventDefault。mobile 长按时 touch→mouse 翻译 fires mousedown，
    xterm listener winning the race → preventDefault → native selection
    blocked. Timing 不确定就 "偶尔" fail。
  - Fix: dead pane container 装 capture-phase mouse* event listener
    `stopImmediatePropagation`，切 xterm 所有 mousedown / mousemove
    / mouseup / contextmenu listener。helper textarea 已 disabled，
    dead pane 没真实 mouse interaction (Resume / Delete 在 header 外
    container 不影响)，所以切 xterm mouse routing 无副作用。touch
    events 不动 — mobile OS-level 长按 selection 不经过 JS event
    chain，user-select:text 的 DOM spans 直接被系统选中。
  - 同时移除 P2 mouse-mode reset (`t.write('\x1b[?...l')`) — P7 capture-
    phase stop 让 SelectionService 完全看不到 mousedown，是否 enabled
    无关，省去依赖 snapshot 含 mouse mode escape sequence 这个 fragile
    assumption。
  - dead-session-pane.tsx 改: 加 4 个 capture-phase listener (mousedown
    / mousemove / mouseup / contextmenu) stop + cleanup; 移除 P2
    mouse-mode reset write
  - Verification: mobile e2e (iPhone 13) test 通过；typecheck:all / 360
    test / lint / lint:md / build:all / healthz 全过。mobile race
    condition 实际行为请你手机再验。

## Phase 1.5 — P6 polish (feedback 2026-05-13T03-32-40-644Z)

- [x] P6. P5 ship 后 user 反馈 "这个文本层事实上还是非对齐的。我们不能
  直接从 xterm 中拉取元素，或者找第三方解决方案吗" —— P5 plain-text
  `<pre>` 在 mobile 高 dpr 下边缘仍有视觉错位感（line-height + 字体
  rendering sub-pixel），user 提议从 xterm 直接拿元素。
  - User 建议方向是对的: xterm 5.x 默认就是 DOM renderer（用 `<span>`
    渲染每个 cell with inline fg/bg color），active pane 显式 loadAddon
    WebglAddon/CanvasAddon 才覆盖。dead pane 不 load addon → 默认 DOM
    renderer → cells 是 native HTML 文本 + xterm 自己算 cell metrics
    保证 alignment + 保 ANSI colors。
  - 但 `xterm.css` line 41 在 `.xterm` 上设 `user-select: none`，DOM
    renderer cells 仍被禁 native selection。需 override:
    - `web/src/styles/xterm-overrides.css` 加 `[data-dead-pane="true"]
      .xterm, [data-dead-pane="true"] .xterm * { user-select: text;
      -webkit-touch-callout: default; }` 仅作用 dead pane (active
      pane 不受影响保留 xterm SelectionService drag selection)
    - 同 file 加 `[data-dead-pane="true"] .xterm-viewport { touch-action:
      auto }` 解开 OS 长按 gesture（active pane 仍 `touch-action: none`
      防 scroll desync）
  - `dead-session-pane.tsx` revert P5 plain text，mount xterm 回 container
    + 不 loadAddon WebglAddon/CanvasAddon → 默认 DOM renderer。container
    加 `data-dead-pane="true"` 让 CSS override scope。
  - 保 P2 mouse-mode reset + textarea.disabled (mobile 软键盘 prevention)。
  - 移除 P5 offscreen Terminal + plain text extraction + `<pre>` render
    路径。terminal-touch.ts P1/P3 detail fix 仍保留给 active pane
    defensive。
  - mobile e2e test update: selector `pre[aria-label="dead session
    snapshot"]` → `[data-dead-pane="true"] .xterm-rows`，加
    waitForSelector('.xterm-rows > div') 等 DOM renderer RAF tick 完。
  - spec delta `openspec/specs/sessions/persistence.spec.md`: 改写
    "Dead pane DOM renderer (P6)" 段 — 废弃 P5 plain-text approach。
  - Trade-off: 比 P5 +恢复 ANSI colors + xterm 自算 cell metrics 对齐
    (vs P5 line-height 默认 + 字体 rendering issues)。DOM renderer 一次
    性 render 性能 cost (~700ms) 在 dead pane (static snapshot) 可接受。

## Phase 1.5 — P5 polish (user feedback: 位置不准 + 影响 sidebar)

- [x] P5. P4 ship 后 user 反馈 "首先位置不准确。其次这影响了整个
  sidebar的使用。你有做测试吗" —— P4 我只 typecheck/build/healthz
  没 mobile 实测，确实疏忽。
  - 位置不准确 root cause: xterm canvas 在高 dpr (Xiaomi 17 Pro
    dpr=3.25) cellWidth 取整 ≠ browser monospace measureText，overlay
    glyph 网格无法 sub-pixel 精确对齐 xterm cell 网格 → selection
    打错 word。
  - sidebar 受影响 root cause: overlay `position: absolute` + `z-index: 10`
    + parent `relative` 无显式 z-index 不创独立 stacking context，
    overlay 实际 elevate 超过预期；`pointer-events: auto` 拦截 dead
    pane area 所有 touch，sidebar drawer swipe-from-edge 路径被吃。
  - P4 双层对齐 sub-pixel 是 hard problem 难精确修。决定废弃 overlay
    方案，dead pane 完全用 plain text 替代 xterm visual：
    - dead-session-pane.tsx: 用 offscreen `Terminal` (no `t.open()`)
      parse snapshot → 提每行 plain text → 渲染 `<pre>` 不依赖 canvas
    - 失 ANSI colors，但 alignment 100% 正确 (一层 native text 自一致)
      + 不影响 sibling layout (无 z-index 提升)
    - 移除 xterm mount + textarea.disabled + mouse-mode reset 路径
      (P2 fix 不再需要 — 没 xterm canvas 路径)
    - P1/P3 setupTouchInteraction detail fix 在 terminal-touch.ts 仍
      保留给 active pane 用
  - spec delta `openspec/specs/sessions/persistence.spec.md`: 改写
    "Dead pane plain-text render (P5)" 段说明废弃 overlay + 新 plain
    text approach
  - 自检教训: web UI 改动 ship 前应跑 mobile viewport e2e 截图自检，
    桌面 typecheck/build/healthz 不能验 mobile native 行为
    (per memory feedback_e2e_visual_verify)
  - P5 加固: `web/e2e/visual.spec.ts` 加 "mobile (iPhone 13)" describe
    group + iPhone 13 viewport (390×844 / dpr=3 / isMobile / hasTouch)
    test — 验 sidebar drawer ☰ 可见 + tap 打开 drawer + Range API 程序
    选择 `<pre>` 返回非空 (proxy for native selectability; playwright
    不能驱动 OS-level long-press handles，但 Range 可选 = native 长按
    也能选)。截图 `visual-dead-session-pane-mobile-dark.png` 自检
    确认 layout 干净无浮层覆盖。回应 user "你能不能模拟 iPhone 布局做
    e2e 测试" — 是可以的，之前疏忽了。

## Phase 1.5 — P4 polish (feedback 2026-05-12T22-17-08-940Z)

- [x] P4. P3 ship 后 user 反馈 "现在长按能选词 但没有弹出文本选中的
  左右边界调整提示。ccanywhere 这个名字有"（对比 sidebar HTML 标题文字
  长按弹的 system selection handles）。
  - Root cause 不在 P1/P2/P3 selection 路径——xterm canvas / WebGL
    render 是 pixel image，mobile 系统级 selection handles 只在 native
    HTML 文本元素上才出现。我们 dispatchMouseEvent 路径只触发 xterm
    内部 selection 高亮，无法生成系统 handles。
  - Fix: 在 xterm canvas 上叠一层透明 `<pre>` overlay 承载 plain text，
    让 mobile 长按 overlay → 系统级 selection handles。
    - dead-session-pane.tsx: `t.write(snapshot, callback)` 完成后从
      `buffer.active.getLine(y).translateToString(true)` 提每行 plain
      text，trim 尾部空行，setState 触发 `<pre>` overlay 渲染
    - `<pre>` overlay 严格对齐 xterm cell grid：相同 font-family /
      font-size / line-height=1.0，color: transparent，user-select: text，
      -webkit-touch-callout: default，z-index: 10
    - terminal-config.ts: 抽 `FONT_FAMILY_DEFAULT` 常量让 active pane /
      dead pane xterm / dead pane overlay 三处共用，glyph 对齐
    - terminal.tsx: 用 `FONT_FAMILY_DEFAULT` 替换 hardcoded 字符串
    - 移除 dead pane setupTouchInteraction wiring (P1/P3 detail fix
      在 terminal-touch.ts 仍 stay 给 active pane defensive 用)
  - spec delta `openspec/specs/sessions/persistence.spec.md`: Resume
    路径段加 "Dead pane plain-text overlay (P4)" 子段

## Phase 1.5 — P3 polish (feedback 2026-05-12T21-48-04-655Z)

- [x] P3. P2 ship 后 user 反馈 "updatd" 仍 fail。Ops 显示
  `touch.longpress: 5` + `term.selection.copy.empty: 2` + **`touch.drag
  .move: 0`** —— user 长按不动。
  - Root cause not in P1/P2 (那俩仍 needed)，而是 hold-only 长按本身
    在 xterm SelectionService 下产出 empty selection: 单纯 mousedown
    (detail=1) 走 `_handleSingleClick` 只设 `selectionStart`；没有
    后续 mousemove → `selectionEnd` 永远不被设；`selectionText` getter
    `if (!start || !end) return ''` 直接返回空。
  - Mobile native long-press UX 期望选词（类似 dblclick），不是
    drag-to-select 起点。
  - fix: longPressTimer fire 时 dispatchMouseEvent('mousedown', x, y, 2)
    —— detail=2 路由到 `_handleDoubleClick` → `_selectWordAtCursor` →
    selectionStart + selectionEnd 都设为 word range + activeSelectionMode
    = WORD。drag 后续 mousemove 在 WORD mode 下 by-word extend
    (`_selectToWordAt`)。
  - dispatchMouseEvent 加 detail 参数（default 1），仅 long-press
    路径传 2；mousemove / mouseup 默认 detail=1 不变。
  - spec delta `openspec/specs/web-frontend/terminal.spec.md`：selection
    路径段 detail 子段 + 长按 Scenario assertion 更新为 detail=2 +
    `_handleDoubleClick` + WORD mode。
  - P1 + P2 仍 needed: P2 enable SelectionService 是先决条件，P1
    的 detail 字段框架是 P3 detail=2 的复用。

## Phase 1.5 — P2 polish (feedback 2026-05-12T21-41-55-973Z)

- [x] P2. P1 ship 后 user 反馈 "似乎还是不支持选中"。Ops 显示
  `touch.longpress: 2` (timer fire 正常) 但 `term.selection.copy.empty: 1`
  —— 长按路径走通了，但 SelectionService 拒绝了 mousedown。
  - Deeper root cause: cc TUI 启用 xterm mouse-mode (DEC private mode
    `?1000` / `?1002` / `?1006` 让 cc 自己捕获 click)。SerializeAddon
    序列化 snapshot 时**保留**这个 state。dead pane `t.write(snapshot)`
    时 xterm 处理这些 escape → `coreMouseService.onProtocolChange`
    → **`SelectionService.disable()`** (Terminal.ts:728)。disabled 状态
    下 mousedown 见 `!_enabled && !shouldForceSelection`（touch 无
    modifier）直接 return (SelectionService.ts:454-457) — 不论 detail
    几都不进 _handleSingleClick。
  - fix: `web/src/components/dead-session-pane.tsx` 在 `t.write(snapshot)`
    后立即 `t.write('\x1b[?9;1000;1001;1002;1003;1004;1005;1006l')` 重置
    所有 mouse-mode DEC private mode → onProtocolChange events=0 →
    `SelectionService.enable()` → 长按 / 双击 / drag-select 全部工作
  - spec delta `openspec/specs/sessions/persistence.spec.md` Resume 路径
    段加 "Dead pane 必须 reset mouse mode (P2)" 子段
  - P1 (detail:1) 仍保留 — 是 SelectionService enable 后让
    `_handleSingleClick` 路径设 `selectionStart` 的必要条件

## Phase 1.5 — P1 polish (user 反馈 2026-05-13)

- [x] P1. user 反馈"双击能选中词，但长按没有选择功能"。Root cause:
  我们 `dispatchMouseEvent` 用 `new MouseEvent(type, ...)` 构造但没
  设 `detail`，默认 `0`；xterm SelectionService.handleMouseDown 用
  `event.detail === 1 / 2 / 3` 区分单 / 双 / 三击路由到
  `_handleSingleClick` / `_handleDoubleClick` / `_handleTripleClick`
  (`web/node_modules/@xterm/xterm/src/browser/services/SelectionService.ts:481-490`)
  —— detail=0 三个分支都不命中，`_model.selectionStart` 不会被设，
  后续 `_handleMouseMove` 见 `!selectionStart` 直接 return，drag
  无法扩展 selection。
  - fix: `web/src/components/terminal-touch.ts` `dispatchMouseEvent`
    加 `detail: 1`（让合成 mousedown 进 `_handleSingleClick` 路径
    设 selectionStart）
  - spec delta `web-frontend/terminal.spec.md`: selection 路径段加
    "detail=1 required" 段
  - 同 fix 也修了 active pane 上 long-press copy 的潜在问题（之前
    mobile browser auto-translation 可能偶然带 detail=1，但
    `.xterm-viewport { touch-action: none }` 下不应依赖 OS 路径——
    我们的合成 event 应自带 detail=1）

## Phase 2 — Ship

- [x] T2.1. commit `fix(web): m-dead-pane-touch-select — dead pane 长按选择文本`
- [x] T2.2. archive `mv changes/m-dead-pane-touch-select
  archive/<date>-m-dead-pane-touch-select` + 回填 hash
- [x] T2.3. spec delta：`openspec/specs/web-frontend/terminal.spec.md`
  长按 selection 段后加 "Dead session pane readonly mode" 子段 + 2
  Scenario（dead pane 长按复制 / 不响应 pinch-zoom）
- [x] T2.4. user mobile 手验长按选择 + 复制
