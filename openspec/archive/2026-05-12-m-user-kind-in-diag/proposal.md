---
status: shipped
shipped_at: 2026-05-12
---

# Proposal: m-user-kind-in-diag — account class 注入 diag

## Intent

Feedback / 崩溃 reports 当前没区分是 owner（host）还是 limited
（guest token user）报的——两者权限边界 / 默认配置 / 故障模式都
不同。triage 必须能 1 秒分辨。

## 决策摘要

D1. **数据来源 = `useAuthStore.getState().kind`**。BACKLOG 原描述
    "mount 时 fetch /api/me/quota"，但 auth store 已经持有 kind
    （probeSession / runLogin / runTokenLogin 三条路径都 setState），
    再 fetch 是重复 round-trip。直接 read store。
D2. **collectDiag 内部读取**，不通过 extra 参数注入。kind 是稳定的
    auth state，不需要 caller 每次重传；store 是 single source。
D3. **字段 = `DiagApp.userKind?: 'owner' | 'limited'`**。logged out
    时 omit（与现有 optional pattern 一致）。

## 落地点

- `web/src/state/diag.ts` — import `useAuthStore` + `UserKind`；
  collectDiag 在 app section 加 `const userKind =
  useAuthStore.getState().kind; if (userKind !== null) app.userKind
  = userKind;`
- `web/src/state/diag.test.ts` — beforeEach/afterEach 加
  `resetAuthStoreForTest()`；新 2 case 测 logged-in (kind='limited')
  注入 + logged-out (kind=null) omit

## 形式化保证

F1. logged-in 时 diag.app.userKind ∈ {'owner', 'limited'}（auth
    store kind 类型保证）
F2. logged-out 时 diag.app.userKind 缺省，不写 undefined / null

## 不做

- 不 fetch `/api/me/quota` — store 已有 kind
- 不暴露 username / token id（privacy）
- 不实时 update — diag 是单帧 snapshot，store 变化下次 collect 自动跟进

## 范围

~10 LOC delta（diag.ts +3 + diag.test.ts +20）

## 关联

- 出处：BACKLOG B3；同主题 B2 (m-build-sha-in-diag) 上一笔 ship
- 评审/triage 流程：`<sha> @ <time> / userKind=limited` 这种 diag
  组合让 triage 不需要二次询问 user
