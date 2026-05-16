---
status: in-flight
---

# Proposal: m-share-header-sticky — share 顶部 header sticky 避免滚走

## Intent

BACKLOG B20 (2026-05-16 user dogfood)：share 页面顶部 chip / 项目信息
随上下滑动一起滚走，导致下面对话区缺少持续可见的"我在看哪个 share"
锚点 + 切换主题按钮的视觉关系断裂。

实际 root cause 不是 chip 在滚：
- `.theme-toggle` 已是 `position: fixed; top: 12px; right: 12px;`，
  CSS spec 下不跟随 scroll
- 真正滚走的是 `<header.page>`（含项目名 h1 + meta），是 normal flow
- user 滚到中段时项目名 / meta 不在视口；chip 仍浮但与上下文断裂

修法：让 `<header.page>` 改 sticky top-0 + bg + z-index，常驻视口顶；
chip 保持 fixed top-right 位置不变（user 心智模型不破）。两者视觉上
联合形成一条 "share 元信息 + 主题切换" 顶部 bar。

## Scope

仅 `src/share/render-assets.ts` CSS 改：
- `header.page` 加 `position: sticky; top: 0; background; z-index`
- 保留 normal flow padding；增 padding 在 sticky 状态保持视觉间距
- `.theme-toggle` 不动（仍 fixed top-right）

不改 `render.ts` 结构。不改任何路由 / API。

## 决策

### D1. sticky 不是 fixed

sticky 保留 layout 空间（对话内容从 header 之后开始），不会出现
fixed 浮元素遮挡下面内容的问题。fixed 已用在 chip 上，独立 button
浮窗合理；header bar 应占 layout 流。

### D2. 不把 chip 内嵌 header

chip 内嵌会破坏 header `flex-direction: column gap: 4px` 布局
（h1 / meta 是垂直叠加），且 user 现在的心智模型是"右上角按钮"，
内嵌位置变化反而 disorient。chip + header 各自管位置，视觉上联合
形成顶部 bar 即可。

### D3. bg 用 var(--bg) 不用 var(--bg-elevated)

share 主区域 bg = var(--bg)。header bg 与主区域一致避免色差；chip
已自带 var(--bg-elevated) 边框区分。

### D4. z-index 用低值（如 10）

无 Tailwind 体系，直接 `z-index: 10` 即可——chip fixed 默认 z-auto
+ 后定义元素后绘制，已浮在 sticky header 之上。

## 落地点

| 文件 | 改动 |
|---|---|
| `src/share/render-assets.ts` | `header.page` 加 sticky / top: 0 / background: var(--bg) / z-index: 10 / padding 调整保持视觉 |

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| 滚动时项目名 / meta 常驻顶部 | header.page position: sticky + top: 0 |
| 对话内容不被遮挡 | sticky 保留 layout 空间（不像 fixed 浮上层） |
| 主题切换 chip 位置不变 | .theme-toggle CSS 不动 |
| 视觉一致 | header bg = var(--bg) 与主区无色差 |

## 不做

- 不改 chip 位置 / 样式
- 不重新设计顶部 bar（合并 chip 进 header 是更大改动，留 follow-up）
- 不动 footer / container padding
- 不引入移动端单独样式（sticky CSS 在 mobile 同样工作）
