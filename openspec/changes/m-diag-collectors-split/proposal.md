---
status: planned
---

# Proposal: m-diag-collectors-split — collectDiag 大函数拆 collectors

## 状态

planned。`web/src/state/diag.ts:159-315` 单函数 `collectDiag` 156 行内
嵌 8 个 section：

- `env` (`:166-196`, 30 行)
- `page` (`:198-203`, 5 行)
- `viewport` (`:206-229`, 23 行)
- `net` (`:232-241`, 9 行)
- `app` (`:244-254`, 10 行)
- `ws` (`:257-270`, 13 行)
- `term` (`:273-300`, 27 行)
- `memory` (`:303-312`, 9 行)

可读，但单测无法独立验证某一段（例如 "net 段在 navigator.connection
未定义时不写 effectiveType"）。每段拆 helper 后可分案测试。

## Intent

把 collectDiag 拆成 8 个内部 collectors，主函数变 ~25 行 composition：

```ts
export function collectDiag(extra: DiagExtra = {}): Diag {
  const out: Diag = {};
  if (active !== null) out.activeSessionId = active.sessionId;
  out.env = collectEnv();
  out.page = collectPage();
  out.viewport = collectViewport(active);
  out.net = collectNet();
  const app = collectApp(active, extra);
  if (app !== null) out.app = app;
  if (active !== null) {
    out.ws = collectWs(active);
    out.term = collectTerm(active);
  }
  const memory = collectMemory();
  if (memory !== null) out.memory = memory;
  return out;
}
```

## 形式化保证

每个 collect* helper MUST：

- 纯函数（无副作用，不读 active 之外的全局 state）
- 输入：active: ActiveSlot | null（需要时）+ extra: DiagExtra（app 需要）
- 输出：对应 sub-type 或 null（memory / app "无字段则不写整段"）
- 浏览器 API 缺失时 fail-soft（try/catch + 跳过字段，不抛）

## 落地点

- 改 `web/src/state/diag.ts`：
  - 提取 8 个 `collect*` helper（模块内私有，不导出）
  - `collectDiag` 改 composition
- 新建 `web/src/state/diag-collectors.test.ts`（如果要分案测试 helper，
  需把 helper 改成 module-internal-but-exported；倾向不导出，借现有
  `diag.test.ts` 通过 window 替身覆盖各分支）

## 范围

~100 LOC 重排（净零增减）

## 决策点（启动前定）

- export collect* 给测试 vs 走 `vi.stubGlobal(...)` 替身：倾向不导出。
  vitest 已能通过 jsdom + stubGlobal 替换 navigator / window 各字段，
  导出会污染公共 API
- collectTerm 内 reach `term._core._renderService` 私有属性的部分拆不
  拆：不拆。整段在 collectTerm 内已隔离
- 是否一并改 `noteTermWrite` / `setActiveTerm` / `resetActiveForTest`
  API：不动

## 不做

- 不改 Diag 类型本身（外部消费包括 server 端 envelope schema）
- 不增加新字段；review 中若觉得某字段该加，单独 follow-up
- 不动 `__CC_VERSION__` 全局注入逻辑 (vite define)

## 关联

- 出处：本评审 B4
- 依赖：无
