# Proposal: m-user-prefs — 用户级偏好（首要 use case: mobile toolbar layout）

## Intent

mobile MobileToolbar 当前硬编码两个 3×2 grid（ctrl 左 / nav 右）。用户
需要按个人手感自定义按键内容、位置、行列数（"D1=c 完全自定义"）。配置
要跨设备同步（"D3=用户级"），所以存服务端 `user.preferences`，不走
localStorage。

首期只覆盖 toolbar layout；schema 留出空间未来加其它偏好（theme override、
font size 同步等）但不在本 change 范围。

## 决策摘要

| # | 决策 | 拍 |
|---|---|---|
| D1 | 可配置粒度 | c 完全自定义按键内容 + 位置 + 行列数 |
| D2 | 入口 | 后续单独设置页面 / 主页 dialog；chunk C 范围 |
| D3 | 持久化 | 用户级（user.preferences 服务端存）— 跨设备 |
| D4 | 默认 layout | 当前硬编码（ctrl 左 + nav 右 termux 风格） |
| D5 | 范围 | 仅 mobile（与现 toolbar `@media (pointer: coarse)` 一致） |

## 数据模型

```ts
// shared 类型（src/users/types.ts 加导出 + web 用 fetch 解析）

interface ToolbarKey {
  /** unique within layout, drives React key. */
  id: string;
  /** button text content. */
  label: string;
  /** optional accessibility / hover tooltip. */
  ariaLabel?: string;
  title?: string;
  /** how to act on click. */
  action: 'plain' | 'ctrl-letter' | 'toggle-sticky-ctrl';
  /** for 'plain': raw bytes (escape seq or char);
   *  for 'ctrl-letter': lowercase a-z;
   *  for 'toggle-sticky-ctrl': ignored. */
  payload: string;
}

interface ToolbarLayout {
  /** 1..3 rows. */
  rows: number;
  /** 3..8 cols. */
  cols: number;
  /** row-major, length = rows × cols; null = empty cell. */
  cells: ReadonlyArray<ToolbarKey | null>;
}

interface UserPreferences {
  toolbar?: ToolbarLayout;
}
```

服务端 `User` 接口加 `preferences: UserPreferences`，default `{}`。
持久化在 `users.json`。旧 user record load 时 preferences 默认 `{}`。

## API

```
GET  /api/me/preferences
  200 { toolbar?: ToolbarLayout }       // 缺 = 用默认 layout
  401 unauthorized                       // 无 cookie

PUT  /api/me/preferences
  body: { toolbar?: ToolbarLayout | null }   // null = 清掉回默认
  200 { toolbar?: ToolbarLayout }
  400 invalid_request                    // schema 校验失败
  401 unauthorized
```

两条都 cookie-gated（owner / limited 都允许；config 是 per-user）。

服务端 schema 校验：
- rows ∈ [1, 3], cols ∈ [3, 8]
- cells.length === rows × cols
- 每个非 null cell:
  - `id` 唯一（layout 内）+ ≤ 64 char
  - `label` ≤ 16 char
  - `action ∈ {'plain', 'ctrl-letter', 'toggle-sticky-ctrl'}`
  - `payload` ≤ 16 char
  - 'ctrl-letter' payload 必须 a-z 单字符

## 三 chunk 拆分

### Chunk A: 后端 schema + API（~150 LOC）

- `src/users/types.ts` 加 `UserPreferences` / `ToolbarLayout` / `ToolbarKey`
  types，导出。
- `src/users/store.ts` 加 `getPreferences(userId)` / `setPreferences(userId,
  prefs)` methods；User 接口加 `preferences` 字段（旧 record load 默认 `{}`）。
- `src/server/routes/auth-multi-user.ts` 加 GET/PUT
  `/api/me/preferences`（cookie-public, hookEarlyAuth req.user 必填）。
- zod schema 校验。
- 单测：UserStore prefs roundtrip + load/persist + 旧 record migration。
- server.auth-token.test 加 GET/PUT 两 cases。

### Chunk B: 前端 toolbar 从 preferences 渲染（~120 LOC）

- `web/src/state/prefs.ts` zustand store：mount 时 GET /api/me/preferences
  + cache + manual refresh + setLocal helper。
- `web/src/components/mobile-toolbar.tsx` 改造：
  - 默认 layout 提取到 `default-toolbar-layout.ts`（current hardcoded 12 keys）
  - 从 prefs store 读 layout，fallback default
  - 按 ToolbarKey.action 派发 sendPlain / sendCtrlLetter / toggle ctrl
  - CSS grid-template-columns/rows 动态根据 layout.cols/rows

### Chunk C: 编辑 UI（~200 LOC）

- 入口：terminal-header 加 ⚙ button → 打开 dialog（暂不开独立 /settings 页）
- Dialog 内容：
  - rows / cols 选择 (1..3 / 3..8)
  - grid 展示每 cell（label 显示，click → key picker）
  - key picker：内置 catalog（Esc/Tab/⇧Tab/arrows/Enter/BS/Home/End/PgUp/
    PgDn/Del/Ctrl/^A..^Z）+ "清空"
  - 保存按钮 → PUT /api/me/preferences + prefs store refresh
  - "重置默认" 按钮 → PUT { toolbar: null }
- 校验前端同步（与服务端 zod 一致），错误提示

## 形式化保证

| 性质 | 机制 |
|---|---|
| 跨设备 layout 一致 | 服务端 user.preferences 单一来源；客户端不持久化 |
| 默认 layout 总可用 | 后端返 toolbar 缺失 / null → 客户端 fallback default |
| 旧 user record 不破 | UserStore load 时 preferences ?? {} |
| 限制 cell 数防 abuse | rows × cols ≤ 24 cells |
| 自定义 cell action 安全 | payload ≤ 16 char + 字符集校验（'plain' 不含 control 字节 > 0x7f；'ctrl-letter' 仅 a-z） |

## 不做

- localStorage cache（每次 mount 拉 server）— 后续按需加
- 拖拽编辑（先 click-to-edit cell；拖拽 LOC 太大）
- 独立 /settings route（chunk C 用 dialog；page 后续）
- preset 模板库（chunk C 后再加 "load preset" 选项）
- 偏好 sync 冲突解决（最后写赢）

## 关联

- 依赖：m-multi-user (#44) — req.user 由 hookEarlyAuth 注入
- 不阻塞：m-fit-cols-off-by-one / share v1+ 等
