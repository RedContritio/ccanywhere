# Tasks: m-user-prefs (shipped 2026-05-12)

整体 design 见 `proposal.md`。三 chunk 全部 ship；activeSession 同步合入
chunk A 一笔（按用户洞察"也是用户级跨设备"）。

## Chunk A: 后端 schema + API (`2059146`)

- [x] T1. types.ts 加 ToolbarKey / ToolbarLayout / UserPreferences + User
  接口加 preferences + lastActiveSessionId
- [x] T2. UserStore: load 迁移旧 record 默认值 / getPreferences /
  setPreferences / setLastActiveSession
- [x] T3. routes/auth-multi-user.ts GET/PUT /api/me/preferences +
  GET/PUT /api/me/active-session
- [x] T4. UserStore unit 测 +7 cases (含 legacy load migration)
- [x] T5. server.auth-token.test +8 cases (含 ctrl-letter payload 校验
  400 / null clear)

## Chunk B: 前端 toolbar 渲染 (`b458ce9`)

- [x] T6. toolbar-layout.ts 提取 DEFAULT_TOOLBAR_LAYOUT 常量 + wire types
- [x] T7. state/prefs.ts: usePrefsStore (load/saveToolbar/reset) +
  useActiveSessionStore (load/setRemote)
- [x] T8. mobile-toolbar.tsx 改 data-driven 渲染 + dispatch by action
- [x] T9. CSS --mt-cols / --mt-rows 动态 grid
- [x] T10. prefs store 10 测 + mobile-toolbar 6 测
- [x] +. workspace.tsx URL/store/remote 三路 sync

## Chunk C: 编辑 UI (`<this commit>`)

- [x] T11. toolbar-key-catalog.ts：nav (8) / mod (6) / control (Ctrl + ^A..^Z) 共 41 entries + instantiateCatalogEntry helper
- [x] T12. toolbar-edit-dialog.tsx：row/col 选择 + grid cell click → picker
  + 分组 catalog + 清空 / 保存 / 重置 / 取消
- [x] T13. workspace.tsx terminal-header 加 ⚙ button (.terminal-header-prefs)
- [x] T14. dialog 9 测 (render / cell pick / clear / save / reset /
  save-error / rows resize)

## 验证

- [x] pnpm typecheck:all / lint / lint:md exit 0
- [x] root test 294/294 / web test 92/92（旧 67 + 16 chunk B + 9 chunk C）
- [x] pnpm build:all 成功
- [x] launchctl kickstart → healthz 200
- [x] e2e 6/6 pass
- [x] bundle 含新 symbol (toolbar-edit / terminal-header-prefs / 快捷栏布局)

## Commits

- 24d0aba feat(prefs): m-user-prefs chunk C — toolbar 编辑 dialog + key catalog + 归档
- b458ce9 feat(prefs): m-user-prefs chunk B — 前端 toolbar 从 preferences 渲染 + active-session 同步
- 2059146 feat(prefs): m-user-prefs chunk A — user.preferences + lastActiveSessionId schema + API
