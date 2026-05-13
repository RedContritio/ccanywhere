---
status: shipped
shipped_at: 2026-05-12
---

# Proposal: m-build-sha-in-diag — build sha + timestamp 注入 diag

## Intent

Feedback / 崩溃 reports 当前不带 web bundle 版本信息，triage 时只能
猜哪个 commit 引起的 bug。注入 build sha + 时间戳到 diag，让每条 feedback
能直接定位对应 commit。

## 决策摘要

D1. **注入方式 = vite `define`**。build 时把 `__CC_VERSION__` 替换成
    字面量。dev 时也注入（开发者 self-feedback 也带版本）。
D2. **版本字符串格式 = `<short-sha> @ <ISO timestamp>`**。short-sha 比
    full sha 易读；timestamp 区分同 sha 的不同 build（rebuild 不 bump
    sha 但 timestamp 变）。
D3. **fallback = 'dev'**。git unavailable（detached / CI without git
    history）时不让 build 失败，写 `dev @ <timestamp>` 让 triage 知道
    是 dev / shallow checkout 而非 production。
D4. **全局类型声明放 `web/src/global.d.ts`**。`__CC_VERSION__` 是 build
    time injected magic constant，需 ambient declaration 让 TS 接受。

## 落地点

- `web/vite.config.ts` — execSync `git rev-parse --short HEAD`；构造
  `CC_VERSION = "<sha> @ <ISO>"`；define `__CC_VERSION__:
  JSON.stringify(CC_VERSION)`
- `web/src/global.d.ts`（新）— `declare const __CC_VERSION__: string;`
- `web/src/state/diag.ts` — `DiagApp.version?: string`；collectDiag
  内读 `__CC_VERSION__` 写入 `app.version`
- `web/src/state/diag.test.ts` — strict toEqual 改 toMatchObject
  容忍 version 字段；新加 `expect(d.app!.version).toMatch(/^.+ @
  \d{4}-\d{2}-\d{2}T/)` 守护字符串形态

## 形式化保证

F1. `__CC_VERSION__` 是 string（never undefined）。Vite define 在
    build 阶段固化；fallback 路径仍写字符串，不留 undefined。
F2. diag.app.version 形态 `<sha> @ <ISO timestamp>`，正则
    `/^.+ @ \d{4}-\d{2}-\d{2}T/` 守护，diag.test.ts 中 covered。

## 不做

- 不暴露 full sha (40 chars) — short (7 chars) 够 unique，URL 友好
- 不暴露 branch 名 — branch 在 PR / commit message 里有，diag 不复述
- 不暴露 build host / 用户名 — privacy
- 不实时 update（reload 才换）— diag 是单帧 snapshot，不需要 live

## 范围

~15 LOC delta（接近 BACKLOG 原估）

## 关联

- 出处：`openspec/archive/2026-05-12-m-diag-enrich-v2/tasks.md` "未做"
  段；用户后续 backlog 添加为 B2
- 紧接 B3 (user kind 进 diag) — 同主题 diag enrichment，但独立 commit
