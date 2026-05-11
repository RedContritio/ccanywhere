# Proposal: m-keyboard-resize — soft keyboard 升起改 resize cc 而非 translate UI

## Intent

mobile dogfood feedback：软键盘升起时，之前 `.terminal-pane-content` 用
`transform: translateY(-keyboardH)` 整块上抬。光标行表面上可见，但 cc
不知道 `rows` 已被遮挡 → cc 持续向被键盘盖住的物理行写输出 → 新输出
落键盘后面看不见 + scrollback 被推一行出去（dogfood `0d84f615` "key
盘升起没顶 term" 同类病灶）。

改成：键盘升起 → `.terminal-pane-content` `padding-bottom = keyboardH`
让 flex content area 物理收缩 → terminal-host `flex: 1` 实际高度变小
→ ResizeObserver fire → dims state machine `resizedWhileStable` →
fit.fit() + sock.send('resize', cols, rows) → cc 重绘到可见区。

## 决策

- **不用 visualViewport.translate** —— cc 收不到 resize 信号；rows 不收缩
- **改 padding-bottom 物理收缩** —— flex 自然 propagation + ResizeObserver
  原生触发已存在的 dims state machine
- **workspace-header 保留 transform 反向 counter** —— 应付 `vv.pageTop > 0`
  的浏览器 auto-scroll；与键盘高度路径独立
- **cleanup 路径同步** —— unmount 时清 padding-bottom + workspace-header
  transform

## 落地

- `web/src/components/terminal-keyboard-overlay.ts`
  - `pane.style.transform = ...` → `pane.style.paddingBottom = "${keyboardH}px"`
  - 注释解释为何 padding 而不是 translate（cc rows 信号路径）
- `web/src/styles/app.css`
  - `.terminal-pane-content` 注释更新
  - `.terminal-header position:relative + z-index` 保留（workspace-header 仍
    transform，stacking context 仍存在，z-index defense 仍合理）
- `web/src/components/terminal.tsx` mount 注释同步

ship: `317d1fb fix(web): 键盘升起改为 resize 而不是 translate`

## 形式化保证

| 性质 | 机制 |
|---|---|
| cc 知道 rows 已变 | padding-bottom 触发 flex 收缩 → ResizeObserver → dims SM → `resize` 帧 |
| 光标 / 新输出永远落可见区 | xterm 物理 render 在 padding 之上 |
| mobile-toolbar 跟随上移 | 它在 .terminal-pane-content flex container 里，padding 推它上去 |
| workspace-header 保持位置 | 它在 .terminal-pane-content **外**，padding 不影响 |
| 浏览器 auto-scroll 矫正 | 仍由 `vv.pageTop > 0` → workspace-header.transform 处理（独立通道）|

## 反向证据 vs translate 方案

旧 translate 方案下：
- cc 写入第 60 行（被键盘盖住）→ 用户看不到
- 键盘收回后，原 60 行内容被推上去 → 看到一坨乱序文本
- scrollback "丢"一行（被遮的行被新行盖写）

padding 方案：
- cc 收到 rows=37（原 60 减键盘占 23）
- cc 在 37 行内重绘；键盘收回后 cc 收 resize rows=60 再扩

## spec delta

`openspec/specs/web-frontend/terminal.spec.md` 加 "Soft keyboard handling"
Requirement，明确：

- MUST 用 padding-bottom 物理收缩 .terminal-pane-content
- MUST NOT 用 transform: translateY 整块上抬
- 触发路径：visualViewport.resize / scroll → 计算 keyboardH → set padding
  → flex propagation → ResizeObserver on .terminal-host → fit + send
  resize
