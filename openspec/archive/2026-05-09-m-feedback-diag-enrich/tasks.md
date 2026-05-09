# Tasks: M-feedback-diag-enrich

## 客户端

- [ ] T1. 新文件 `web/src/state/diag.ts`：`setActiveTerm(slot)` /
  `collectDiag(extra)` / `captureScreen(term)`。`Diag` 类型导出。
- [ ] T2. `web/src/ws.ts` 加 `lastFrameTs` / `lastFrameType` 字段，
  `dispatch()` 入口更新；新增 `getDiag()` 方法。
- [ ] T3. `web/src/state/ops-log.ts` 不改，但确保下面这些 recordOp 调用
  在对应位置加上：
  - `web/src/ws.ts`：`ws.connect`（onopen）、`ws.close`（onclose 含 code/reason）、
    `ws.reconnect`（scheduleReconnect 入口）、`ws.frame.error`（dispatch 解析
    失败 / 未知 type）。limit reconnect 频率到 1/秒避免刷屏。
  - `web/src/components/terminal.tsx`：`term.write.error`（chunkedWrite
    catch）、existing `terminal.renderer` 不变。
  - `web/src/main.tsx`：`window.unhandledrejection`（已有 onunhandledrejection
    listener，确认 recordOp 调到）。
- [ ] T4. `web/src/components/terminal.tsx` mount 时 `setActiveTerm({term,
  ws, sessionId})`，unmount 时 `setActiveTerm(null)`。
- [ ] T5. `web/src/components/feedback-dialog.tsx` submit 时 `body.diag =
  collectDiag({allSessionIds, theme, effectiveTheme})`。提示文字加"附终端
  可见内容"。
- [ ] T6. `web/src/components/error-boundary.tsx` `submitOneClick` 也附
  `diag`（同 T5）。
- [ ] T7. 单元测试：`web/src/state/diag.test.ts`——mock active slot、mock
  navigator.connection、performance.memory，验证 collectDiag 字段。

## 服务端

- [ ] T8. 新文件 `src/server/version.ts`：`getCommitSha()` 缓存读取（先
  `process.env.GIT_SHA`，回落 `git rev-parse`，再回落 `'unknown'`）。
- [ ] T9. `src/session/manager.ts`：`Session` interface 暴露 `lastDataAt`
  （onData 时更新）与 `exitCode`（exit handler 设置）的 getter。
- [ ] T10. `src/server/routes/feedback.ts`：
  - `registerFeedbackRoutes(app, manager)` 加 manager 参数。
  - body schema 加 optional `diag` object（仅校验 `activeSessionId` 是 string，
    其它字段不强校验——允许客户端持续添加新字段不破坏服务端校验）。
  - 落盘 record 注入 `diag`、`serverSession`（命中时）、`serverInfo`
    （commitSha + uptimeMs）。
- [ ] T11. `src/server/server.ts`：`registerFeedbackRoutes(app, manager)`
  调用补 manager 参数；记录 `serverStartedAt = Date.now()`。
- [ ] T12. 服务端单元：`src/server/routes/feedback.test.ts`——POST 带
  `diag.activeSessionId` 命中/不命中 manager 两条 case，验证落盘 JSON。

## 文档与归档

- [ ] T13. tests pass（前端 + 后端 + tsc --noEmit）。
- [ ] T14. 合并 `changes/m-feedback-diag-enrich/specs/` 到
  `openspec/specs/{rest-api, web-frontend}/spec.md`。
- [ ] T15. 移动 `changes/m-feedback-diag-enrich/` 到
  `archive/2026-05-09-m-feedback-diag-enrich/`。
- [ ] T16. commit。
