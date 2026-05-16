# Tasks: m-history-strip-cc-tags (archived 2026-05-12)

- [x] T1. `src/server/history.ts`：定义 CC_SYSTEM_TAGS allowlist (13
  tag) + export `stripCcSystemTags(text)` 函数
- [x] T2. `readFirstUserMessage` 改：extract user text → strip cc tag
  → skip if stripped empty → return first non-empty stripped
- [x] T3. `src/server/history.test.ts`：+ 2 集成 case（`/clear` 序列
  穿透 + leading caveat tag strip）
- [x] T4. + 6 unit case for `stripCcSystemTags`（single / multiple /
  multi-line / unknown tag passthrough / surrounding text / whitespace
  trim）
- [x] T5. typecheck:all / test 顶层 309 pass / build:all / kickstart
  + healthz 200 全过
- [x] T6. commit + archive（本目录）

## Commits

- 55f46ad fix(server): m-history-strip-cc-tags — history preview unwrap command-name / strip 12 noise tag
