# Tasks: m-diag-collectors-split

## 实现

- [ ] 改 `web/src/state/diag.ts`：
  - 提取 `collectEnv()`、`collectPage()`、`collectViewport(active)`、
    `collectNet()`、`collectApp(active, extra)`、`collectWs(active)`、
    `collectTerm(active)`、`collectMemory()` 共 8 个 helper
  - `collectDiag` 改为 composition（~25 行）
  - `captureScreen` 留在 diag.ts 内（仅 collectTerm 调用）
  - active / setActiveTerm / noteTermWrite / resetActiveForTest 保持不动

## 测试

- [ ] 现有 `web/src/state/diag.test.ts` 全过（行为不变）
- [ ] 视情况补 collectors 边界 case（在 navigator.connection /
      window.visualViewport / performance.memory undefined 时不写对应
      字段；走 `vi.stubGlobal` 不导出 helper）

## Spec delta

- [ ] 无 — 内部重排，DiagEnvelope schema 不动

## Ship

- [ ] typecheck:all + lint + lint:md + test pass
- [ ] commit hash:
