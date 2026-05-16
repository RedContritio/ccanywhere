---
status: abandoned
---

# Retrospective: m-live-native-select (ABANDONED)

## Intent (original)

BACKLOG B19：让 live xterm 也支持浏览器原生 selection（mobile 长按
系统菜单 "复制 / 翻译 / 搜索"），与 dead pane 的体验对齐
（m-dead-pane-touch-select P7：DOM renderer + capture mouse stop）。

## Final decision

**ABANDONED 2026-05-16**。经 5 轮 patch（v1-v5.3）+ DOM renderer mobile
fps URL knob 实测 + 剪贴板替代被拒后，user 接受 "移动端不方便复制" 为
trade-off。**dead pane 仍可 native select；live 与 dead 不一致接受为
特性，不再追求 parity**。

## Attempted approaches timeline

### Phase 1：方案 B（toggle mode + overlay xterm）

v1 选 B 因为 BACKLOG 方案 A 的 DOM renderer mobile fps 风险未实测。设计：
mobile-only "选择" button → enter mode → mount 第二个 xterm（DOM
renderer）写入 SerializeAddon ANSI snapshot → exit 时 flush 缓冲的 PTY
data 回 live xterm。

- **v1 base wire**：button + overlay 组件 + pendingBufferRef hook
- **v2 focus jump fix**：user fb (2026-05-16T09:04) "点击选择 滑到最底部" → 推断 button click → focus 漂 → overlay textarea 抢 focus → mobile viewport scroll-into-view。加 blur active + button mousedown/touchstart preventDefault + textarea disable + tabIndex=-1
- **v2.1 撤 onTouchStart preventDefault**：user fb (T09:07) "还是一样"，ops 显示无 enter op — onTouchStart preventDefault 吞了 synthetic click。仅留 mousedown
- **v3 viewport 错位 fix**：user fb (T09:32) trace 显示 scrollY 全程 0（非 page scroll），overlay 落在 baseY=2179 而非 user 看的 viewportY=2132。root：overlay scrollback=0 + ANSI 含 cursor 定位 → DOM follow-tail 滚到底。fix：overlay scrollback=5000 + write callback scrollToLine(liveViewportY)
- **v3.5 FitAddon 撤回**：user fb (T09:43) "微宽"，加 FitAddon 试图按 container 重算 cols/rows → ops 显示 cols 61→60 → ANSI rewrap → scrollToLine 完全错位。user "更差"。撤

### Phase 2：root cause 验证（WebSearch）

xterm DOM renderer 用 `getBoundingClientRect` measure cellW，webgl renderer
用 canvas `measureText`（Mozilla bug 1603412 + xterm issues #5548, #1086,
#3160）。两条路径 inherent sub-pixel 差异，**应用层无法消除**。

### Phase 3：方案 B 变体（serializeAsHTML + innerHTML）

放弃二号 xterm，直接 plain div + setInnerHTML，期望 plain HTML 用同 CSS
metric 减差异。

- **v5 base**：serializeAsHTML + innerHTML
- **v5.1 scroll 重算**：user fb (T10:37) `rowCount=1`（我用 `pre.children` 取到 outer wrapper div）。改 `pre.scrollHeight / totalLines` 比例
- **v5.2 白底 + scroll inner-div**：user fb (T11:28) "暗色主题白色底色 + 跳到底部"。root：SerializeAddon hardcode `color:#000;bg:#fff` 除非 `includeGlobalBackground:true`。改用 `pre > div > div` query inner row divs + 加 `includeGlobalBackground:true`
- **v5.3 行间距 + sidebar z-index**：user fb (T11:33) "行间距大幅增加 + sidebar 被覆盖"。root：HTML `<div>` 默认 line-height ~1.2 ≠ xterm 1.0；overlay z-20 > sidebar drawer z-10。加 `leading-none` + TerminalView outer 加 `z-0` 创 stacking context
- **v5.4 not delivered**：user fb (T11:44) "行间距和宽度都变小了"——`leading-none` 过头。user 此刻介入："反复绕开，有没有绝对正确可靠方案"

### Phase 4：方案 A 评估（DOM renderer global switch）

user 选试 A。我发现 `terminal-config.ts:9-12` 有明确历史警告：

> DOM renderer rebuilds all cell `<span>` children on every row paint
> (~1500 DOM mutations × 30-80 ms on mobile = **700 ms touchmove stalls**
> during fast scrollback drag). Caught in feedback 2d2f1c7d.

提议 user 用现成的 `?renderer=dom` URL knob 实测 mobile fps。user 实测后：
**"不可接受"**。方案 A 也封死。

### Phase 5：方案 B 剪贴板替代

提议"复制 viewport 文本到剪贴板"作为 reframe：user 真实痛点可能是
"对比对话内容"，不是"OS-level long-press selection"。user 拒绝：
**"我也不想要这个剪贴板方案"**。

### Phase 6：ABANDON

接受 "移动端不方便复制" 作为 trade-off。撤回所有 v1-v5.3 代码改动，归档
本评估过程。

## 教训

1. **不可调和的库内差异（renderer measure path / GPU vs CSS）应在
   evaluation 阶段就识别为 hard limit**，不应靠应用层 patch chain 解决。
2. **mobile fps 历史警告（terminal-config.ts:9-12）应在 BACKLOG triage
   阶段就 surface，而不是 phase 4 撤 patch 时才发现**。
3. **user 真实痛点（"对比对话内容"）可能不等于 user 表面诉求
   （"native selection"）**——B 方案中的 "screenshot 功能" 实际是 user
   meta-建议给我用，不是真实 feature 需求；我误读后差点继续做错方向。
4. **5+ 轮 patch fix 后停下来反思（user "反复绕开" 介入）比继续 patch
   更有价值**。下次遇到 visual artifact 出现 3+ 轮 cascade 时主动 escalate。

## 不再追求

- mobile live xterm native selection（renderer-level inherent limit）
- mobile-only DOM renderer auto-switch（fps 不可接受，terminal-config.ts:9-12 历史警告）
- 复制 viewport 到剪贴板按钮（user 拒）
- 第二渲染层 overlay（任何变体——overlay xterm / overlay HTML / overlay snapshot）
- screenshot 功能（user meta-建议非 feature 需求）

## 保留现状

- dead pane 仍可 native select（m-dead-pane-touch-select P7 不动）
- live ≠ dead 视为可接受不一致
- desktop 用 xterm 内置 selection + cmd-c 不变
- mobile live 仅能用 xterm 内置 selection（粗粒度），无 OS-level 系统菜单

## 影响范围

- mobile 用户场景受影响：long-press live xterm 不再触发系统复制菜单
- 用户认可：本次反馈 "移动端不方便复制可以接受作为特性"
- 无代码 ship；本提案归档作为决策记录避免未来重启同方向
