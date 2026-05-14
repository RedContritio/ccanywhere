---
status: shipped
---

# Archive: m-share-button-mobile-visibility — mobile session 行操作按钮 hover-only 看不见

## Intent

修复 session-list 每行的分享 ↗ + 删除 × 按钮在触摸设备上**永远不可见**的
bug。

## 出处

用户 2026-05-14 移动端反馈（Xiaomi 17 Pro，feedback ids
`2026-05-14T06-36-22-340Z` "界面没有反馈" + `2026-05-14T06-36-30-308Z`
"说错了，界面没有分享"——第二条修正第一条措辞）。

## Root cause

`web/src/components/session-list.tsx:92` 把行操作按钮容器设为：

```
opacity-0 transition-opacity
group-hover:opacity-100 group-focus-within:opacity-100
```

桌面 hover / 键盘 focus 才显示。**touch 设备没有 hover 状态** → 按钮在
手机上永远不可见。`/settings` 的 MySharesSection 只能查看已存在的分享，
**创建分享**入口仅在 session-list 行内，所以 mobile 用户根本没法发起分享。

## Fix

className 改为 mobile 常驻 / 桌面保持 hover：

```
transition-opacity
max-md:opacity-100
md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100
```

`<md` 断点（≤768px，覆盖大多数手机）按钮常驻显示；`md+` 维持桌面 hover-
to-reveal 行为不变。

## 形式化保证

- mobile viewport 下 session 行的分享 / 删除按钮在不需要任何指针事件的
  情况下 visible
- 桌面 viewport 下行为不变（保持 hover-only 减少视觉噪音）

## 测试

新增 e2e regression `web/e2e/visual.spec.ts` mobile (iPhone 13) case
`session row share/delete buttons stay visible on mobile (no hover)`：
mock live session → 打开 mobile drawer → 不做 hover 直接断言 share +
delete button visible + 截图归档到 `test-results/visual-session-row-
actions-mobile.png`。

## 落地点

- `web/src/components/session-list.tsx:92` — className 调整
- `web/e2e/visual.spec.ts` — regression case
- 此 archive — root cause + fix 记录

## 不做

- session-list 默认 100% 显示行按钮（桌面也常驻）—— 桌面 hover-to-reveal
  保留视觉密度优势。
- 行上下文菜单 / dropdown 替代直接按钮 —— 增加点击层级，本次不引入。

## 关联

- 后续 m-nav-restructure-globals 会把 ↗ 分享按钮从 session-list 移到
  session topbar；本 fix 仍对保留的 × 删除按钮生效。
