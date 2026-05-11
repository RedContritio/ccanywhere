# Tasks: m-user-prefs

整体 design 见 `proposal.md`。三 chunk 独立 commit。

## Chunk A: 后端 schema + API（~150 LOC）

- [ ] T1. `src/users/types.ts` 加 `ToolbarKey` / `ToolbarLayout` /
  `UserPreferences` 类型 + 导出。User 接口加 `preferences: UserPreferences`。
- [ ] T2. `src/users/store.ts`：
  - load 时 user record 缺 preferences → 默认 `{}`
  - `getPreferences(userId): UserPreferences | null` （null = user 不存在）
  - `setPreferences(userId, prefs)` 持久化
- [ ] T3. `src/server/routes/auth-multi-user.ts` 加：
  - GET /api/me/preferences (req.user 必填) → 200 + prefs
  - PUT /api/me/preferences body schema 校验 → 200 + 更新后 prefs
- [ ] T4. `src/users/store.test.ts` +cases：
  - getPreferences for owner / limited / unknown user
  - setPreferences roundtrip + persist
  - 旧 record (无 preferences 字段) load 后默认 `{}`
- [ ] T5. `src/server/server.auth-token.test.ts` +cases：
  - GET /api/me/preferences for limited user (200 + empty)
  - GET /api/me/preferences for owner (200 + empty)
  - PUT /api/me/preferences set toolbar + GET 返新值
  - PUT body invalid (rows > 3) → 400
  - PUT { toolbar: null } 清掉 (GET 返空)

## Chunk B: 前端 toolbar 渲染从 preferences（~120 LOC）

- [ ] T6. `web/src/components/mobile-toolbar/default-layout.ts` 提取当前
  硬编码 12 keys 为 ToolbarLayout 常量。
- [ ] T7. `web/src/state/prefs.ts` zustand store：
  - state: `{ toolbar: ToolbarLayout | null, loaded: boolean }`
  - actions: `load()` (GET /api/me/preferences), `save(toolbar)` (PUT),
    `reset()` (PUT { toolbar: null })
- [ ] T8. `web/src/components/mobile-toolbar.tsx` 改造：
  - useEffect mount 调 prefs.load()
  - 渲染从 store 读 layout ?? defaultLayout
  - 按 ToolbarKey.action 派发 dispatch
- [ ] T9. CSS grid `--cols` / `--rows` CSS variable 替代固定 3×2 → 动态
  根据 layout
- [ ] T10. 测试：
  - default-layout 单测（与原硬编码 keys 行为等价）
  - prefs store unit (load / save / reset)
  - mobile-toolbar 测试 render 自定义 layout

## Chunk C: 编辑 UI（~200 LOC）

- [ ] T11. `web/src/components/toolbar-key-catalog.ts` 定义内置可选 keys：
  Esc / Tab / ⇧Tab / ↑↓←→ / Enter / Backspace / Home / End / PgUp / PgDn /
  Delete / Ctrl-sticky / ^A..^Z
- [ ] T12. `web/src/components/toolbar-edit-dialog.tsx`：
  - radix-style div backdrop + dialog
  - row / col 选择器 (1..3 / 3..8)
  - grid 视图：每 cell 显示当前 label + 点击打开 key picker
  - key picker（嵌套 dialog or popover）catalog 列表 + 清空
  - 保存 / 重置 / 取消按钮
- [ ] T13. `web/src/pages/workspace.tsx` terminal-header 加 ⚙ button →
  打开 toolbar-edit-dialog（仅 mobile？或一直显示）
- [ ] T14. 测试：
  - 编辑 dialog 增减 row/col 行为
  - key picker 选择更新 cell
  - 保存调用 prefs.save
  - 重置调用 prefs.reset

## 验证（每 chunk）

- pnpm typecheck:all / lint / lint:md / test 全 exit 0
- pnpm build:all 成功
- launchctl kickstart → healthz 200
- chunk B/C ship 后 curl bundle grep 新 symbol 验证

## 归档

- [ ] 三 chunk + spec delta 全 ship 后归档
  `openspec/changes/m-user-prefs/` → `openspec/archive/<date>-m-user-prefs/`
