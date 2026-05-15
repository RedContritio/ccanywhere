---
status: planned
---

# Proposal: m-hook-builder-remove — 删 buildHookSettings + 配套 docs/spec

## 状态

planned。承接 BACKLOG B15（本评审 C1'）。决策：**直接删**，不走
"deprecated 保留" 的中间态。

## 验证：内部真不用

`grep -rn "buildHookSettings\|HookEndpoint" src/` 结果排除 test 后：

- `src/session/hooks.ts` — 定义本体
- `src/session/hooks.test.ts` — 单测自测自己

**production runtime 0 处调用**。函数自 archive
`2026-05-08-m-hook-opt-in` 把 ccanywhere 从"自动注入 hook"改为"opt-in 手贴"
之后已是孤立 helper，spec 化 + docs 引用是历史遗物。

## Intent

把 buildHookSettings + HookEndpoint 全套删除：

- 删源代码本体
- 删测试
- 删 docs 第 6 节
- 改 spec：把"hook 段格式"从"buildHookSettings 输出"重写为函数无关的
  直接 JSON 形状描述

## 形式化保证

ship 后 MUST：

- `grep -r "buildHookSettings" src/` 零命中
- `pnpm test` 全过（hooks.test.ts 一并删，不留 stub）
- `pnpm typecheck:all` 通过（src/index.ts 历史上没 re-export 过，
  外部 surface 无遗留）
- `docs/hooks.md` 仅含手贴方案（第 1-5 节 + 验证段），用户读 docs 不会
  跳到死引用
- `openspec/specs/hooks/spec.md` 自包含描述 hook 段格式，不依赖任何
  函数名

## 落地点

- delete `src/session/hooks.ts` (42 LOC)
- delete `src/session/hooks.test.ts` (64 LOC)
- edit `docs/hooks.md` — 删 :102-118 第 6 节整段（含示例代码）
- edit `docs/deployment.md` :178 — 清理 buildHookSettings 引用句
- edit `openspec/specs/hooks/spec.md` — 改 7 处引用（lines 7 / 29 /
  46 / 70 / 212 / 230）：
  - 删 `buildHookSettings(sessionId, ep) MUST 返回...` Requirement
  - 删 `GIVEN buildHookSettings('abc-123', ...)` scenarios（2 处）
  - 把"hook 段开启状态机驱动"改为"settings.json 含本规范定义的 hook
    段"
  - 把"提供 buildHookSettings() 模板生成器"段改为"docs/hooks.md 提供
    手贴模板"

## 范围

~80-100 LOC：

- -42 hooks.ts
- -64 hooks.test.ts
- -17 docs/hooks.md 第 6 节
- -1 docs/deployment.md 引用句
- ±30 spec.md 重写（删引用 + 改写为函数无关描述）

净 -90 LOC，外部 surface 收缩到 0。

## 决策点

- 已决策（B15 收紧版）：直接删，不保留 deprecated stub
- 已决策：docs 第 6 节整段删，不留 "M5 历史" 备注
- 待定：spec.md 重写时 hook 段格式描述写多详细。倾向写成"事件名列表
  + URL 模板 + INTERNAL_HOOK_TOKEN / sessionId 占位符语义"的最小契约
  （~25-30 行），让 spec 与具体函数完全脱钩

## 不做

- 不动 `openspec/archive/2026-05-08-m-hook-opt-in/`：archive 是历史快照
- 不动 hook 路由 (`src/server/routes/hook.ts`)：receiver 与 builder 无关
- 不动 cc spawn 逻辑 / settings.json 用户配置流程

## 关联

- 出处：BACKLOG B15 决策（"改成纯内部，内部也不用就删"）
- 依赖：无
- 后续 follow-up：无
