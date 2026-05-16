# Tasks: m-feedback-cli (shipped 2026-05-11..2026-05-12)

## Phase 1 — list / show（`f34d195`）

- [x] T1. `src/cli/feedback.ts` 实现 runFeedbackList / runFeedbackShow
- [x] T2. id-prefix 模糊匹配 + multi-match 报候选 exit 1
- [x] T3. summary 显示 ops 直方图 top 10
- [x] T4. `--verbose` / `--json` / `--full` 选项
- [x] T5. `src/cli/feedback.test.ts` 7 cases

## Phase 2 — seen-set dedup（`bfdc40b`）

- [x] T6. `feedback-seen-store.ts` load/persist
- [x] T7. `feedback-mark.ts` mark-seen / forget / mark-all-seen + 共享 resolveIdPrefix
- [x] T8. runFeedbackList 加 `unreadOnly` 默认 true + `--all` flip
- [x] T9. runFeedbackShow 加 `markSeen` 默认 true + `--no-mark` skip
- [x] T10. `--all` 时 `★` 前缀标 unread / 三空格 marker 标 seen
- [x] T11. 7 个 dedup test cases (show 自动 mark / no-mark / mark-all-seen / forget / 持久化到 feedback-seen.json)
- [x] T12. cli.ts dispatch + HELP 文本更新

## spec delta

- [x] T13. `openspec/specs/cli/spec.md` 新建 feedback subcommand
  Requirement（含 seen-set 契约 + Scenarios）

## 归档

- [x] T14. `2026-05-12-m-feedback-cli/`

## Commits

- (no matching commits found in git log)
