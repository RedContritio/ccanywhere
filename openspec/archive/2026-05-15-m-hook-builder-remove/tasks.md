# Tasks: m-hook-builder-remove (shipped 2026-05-15)

## 实施轨迹

按 BACKLOG B15 收紧版决策实施。grep 验证 production 0 处调用
`buildHookSettings`（仅 `hooks.test.ts` 自测自己），函数自
`2026-05-08-m-hook-opt-in` archive 后已是孤立 helper。直接删源码 +
test + docs/hooks.md §6 + spec.md 多处引用。顺手修一个相关 spec
drift：原 docs §2 UserPromptSubmit redirect 是 `>/dev/null 2>&1`，
与 `openspec/specs/hooks/spec.md` `Requirement: UserPromptSubmit
hook stdout 直通` 矛盾，本次改成 `2>/dev/null`。

## 决策对齐

- [x] 直接删，不保留 deprecated stub（B15 收紧版决策）
- [x] docs/hooks.md 第 6 节整段删，不留 M5 历史备注
- [x] spec.md hook 段格式描述 ~30 行，函数无关

## 实现

- [x] delete `src/session/hooks.ts` (42 LOC)
- [x] delete `src/session/hooks.test.ts` (65 LOC)
- [x] edit `docs/hooks.md`：
  - 删第 6 节整段（原 :102-118）
  - §2 `UserPromptSubmit` curl redirect 改 `>/dev/null 2>&1` →
    `2>/dev/null`（spec drift fix）
  - §3 末尾加 **例外** 段说明 UserPromptSubmit 用不同 redirect 的原因
- [x] edit `docs/deployment.md` §6 "从 quota 之前的版本升级" 整段重写：
  删 buildHookSettings 引用 + 简化重生成方法为"改一个 redirect"
- [x] 改 `openspec/specs/hooks/spec.md`（通过
  `changes/m-hook-builder-remove/specs/hooks/spec.md` delta 覆盖）：
  - Purpose 段：`提供 buildHookSettings() 模板生成器` → 改为
    `docs/hooks.md 提供可复制的 hook 段模板`
  - `Requirement: hook 是 opt-in` 段尾：`buildHookSettings 生成的
    hook 段` → 改为 `本规范定义的 hook 段（见 docs/hooks.md）`
  - **删** `Requirement: settings.json 模板生成器` 整段（含 2 个
    `GIVEN buildHookSettings(...)` Scenario）
  - **新增** `Requirement: hook 段格式` 描述 settings.json hooks 字段
    契约，函数无关
  - `Requirement: UserPromptSubmit hook stdout 直通` 4 处引用改为
    `~/.claude/settings.json` / `UserPromptSubmit 事件下的 curl 命令`
  - grep 验证 `buildHookSettings` 全文 0 命中 ✓

## 测试

- [x] `pnpm test`：root 416/416（从原 422 减 `hooks.test.ts` 6 case）
- [x] `pnpm typecheck:all` 通过
- [x] `pnpm lint` 通过
- [x] `pnpm lint:md` 通过

## Spec delta

- [x] `openspec/specs/hooks/spec.md` 删 buildHookSettings 全部引用 +
      重写 hook 段格式为函数无关描述（262 行，原 266 行）

## Ship

- [x] typecheck:all + lint + lint:md + test pass
  - 首次 full `pnpm test` 1 个 flaky failure：
    `manager.persistence.test > markDeleted persists deletedAt eagerly
    (crash safety)` SyntaxError JSON parse；isolation 重跑 5/5 全过 +
    第二次 full 416/416 全过。判定为 concurrent fs race pre-existing
    flaky，与本改动无关（grep 确认 manager.ts / registry.ts 未改）
- [x] build:all + launchctl kickstart + healthz 200
- [x] commit + archive
