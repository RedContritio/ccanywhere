---
status: planned
---

# Proposal: m-e2e-multi-browser — playwright 跑 webkit + firefox functional smoke

## Intent

BACKLOG B6（出处 m-ci-e2e archive）：playwright e2e 当前只 chromium。
加 webkit + firefox 把 functional smoke（smoke.spec.ts）跑全 3 browser，
visual.spec.ts 限 chromium（截图 path 跨 browser 共享，避免覆盖）。

## 决策

D1. **3 browser 仅 functional**：webkit / firefox 只跑 smoke.spec.ts
    （API surface / healthz / login flow / 401 等）。visual.spec.ts
    用 `page.screenshot({ path })` 直接写文件而非 toHaveScreenshot
    baseline 比较，跨 browser 共享 path 会互相覆盖，所以限 chromium。

D2. **不引 baseline 比较**：当前 visual.spec 是 functional assertion +
    截图归档（user manual review）。若未来转 baseline 比较，需要 per-
    project baseline directory + commit baseline 流程。本次不动。

D3. **workers:1 不动**：e2e 跑在 self-hosted runner，单实例（fullyParallel:
    false / workers:1 per playwright.config）。3 browser 串行跑使 smoke
    时长约 1.5-2x（smoke 6 case 全 3 browser = 18 case；visual 10 case
    chromium only）。可接受。

## 落地点

**改写**：
- `web/playwright.config.ts`：projects 加 webkit + firefox 两条，
  testMatch 限 `smoke.spec.ts`
- `.github/workflows/e2e.yml`：`playwright install --with-deps` 改装
  chromium / webkit / firefox 三 browser

## 形式化保证

F1. functional smoke MUST 在 chromium / webkit / firefox 三 browser 全过。
F2. visual screenshot 输出 MUST 限 chromium，避免跨 browser 覆盖同一
    截图 path。

## 不做

- 不引 baseline 比较 / per-browser screenshot directory
- 不改 workers:1（保持单实例 e2e 习惯）
- 不增加 mobile viewport 项（mobile webkit 留未来）

## 范围估算

| 模块 | LOC |
|---|---|
| playwright.config.ts | +8 |
| e2e.yml | +1 |
| **总** | **~9 LOC** |

## Commit 边界

单笔 commit `ci: m-e2e-multi-browser — webkit + firefox functional smoke (B6)`。

## 关联

- 出处：BACKLOG B6（m-ci-e2e archive follow-up）
- 不影响其它 in-flight change
