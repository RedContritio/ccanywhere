# Tasks: M-mobile-spec-realign

## Spec delta（本目录内）

- [x] T1. `specs/web-frontend/spec.md`：MODIFY 终端 renderer 选择策略
  （default dom → webgl）+ ADD 4 个 Requirement（dims state machine /
  mount placeholder / 软键盘视觉上移 / 文本选择与触摸滚动接管）+
  MODIFY 用户反馈渠道（drawer 加"刷新"按钮）。
- [x] T2. `specs/sessions/spec.md`：ADD `Requirement: PTY data 分片追踪`。
- [x] T3. `specs/rest-api/spec.md`：MODIFY `Requirement: POST /api/feedback`
  的 ops 上限说法 + serverSession 字段表加 recentDataChunks。

## 应用到 openspec/specs/

- [ ] T4. 把 T1 delta 应用到 `openspec/specs/web-frontend/spec.md`：
  - 找到 `Requirement: 终端 renderer 选择策略`，逐处把"dom"改"webgl"
    （含 Scenario "默认 renderer 是 dom" → 默认 webgl）。
  - 在 `Requirement: 终端视图` 之后插入 4 个新 Requirement（顺序：
    客户端尺寸生命周期 → 终端 mount 期间显示 placeholder → 软键盘
    视觉上移 → 终端文本选择与触摸滚动接管）。
  - 在 `Requirement: 用户反馈渠道` 末尾追加"drawer 刷新按钮"段落。
- [ ] T5. 把 T2 delta 应用到 `openspec/specs/sessions/spec.md`：
  - 在 `Requirement: server-side 屏幕镜像（screenState）` 之后插入
    `Requirement: PTY data 分片追踪`（与 screenState 紧邻，因为都是
    PTY data 同步派生数据）。
- [ ] T6. 把 T3 delta 应用到 `openspec/specs/rest-api/spec.md`：
  - 修 `Requirement: POST /api/feedback` body schema 注释中的 ops 上限。
  - serverSession 字段表加 recentDataChunks。
  - 加 sub-scenario（命中 / 不命中）。

## 验证

- [ ] T7. `git diff openspec/specs/` 人工对照漂移清单 1:1 无遗漏。
- [ ] T8. `git diff` 仅含 `openspec/` 下文档；无代码 / 测试 / package
  改动（pure doc realign 边界）。
- [ ] T9. tsc / vitest 不需要跑（无代码改动）。

## 归档

- [ ] T10. `git mv openspec/changes/m-mobile-spec-realign
  openspec/archive/<YYYY-MM-DD>-m-mobile-spec-realign`。
- [ ] T11. 用户确认后 commit。

## Commits

- 36af789 docs(openspec): m-mobile-spec-realign — 校准 specs 反映已 ship 的 mobile 改造
