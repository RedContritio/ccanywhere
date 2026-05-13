---
status: planned
---

# Proposal: m-pricing-staleness-sentinel — pricing.ts LAST_VERIFIED + 半年未 verified warn

## Intent

BACKLOG B7 原描述："pricing.ts 改 cached lookup（每周拉一次 Anthropic
价格表或第三方 npm 包）"。但实际 auto-sync 路径都有大问题：

- anthropic.com/pricing 是 React SPA，HTML 不含数字，scrape 需 headless
  browser（~200 LOC + Playwright runtime 依赖）
- 没有公开 pricing API
- 第三方 npm 包搜不到 maintained / 数字与官网一致的（信任根问题）
- runtime fetch + cache file + fallback 链路 复杂度爆炸（≥ 200 LOC）

B7 真实痛点是"hardcoded rates 可能 stale 不知道"。本方案换成更精准 fix：
静态 `LAST_VERIFIED` 常量 + boot 时检查超 180 天 warn。零 fetch / 零
risk / 极简实现，dev 看到 warn 后手动去 anthropic.com/pricing 对照
+ 改 hardcoded + bump LAST_VERIFIED。

## 决策

D1. **不做 auto-sync** —— scrape / fetch / cache 三条路径工程量都远超
    50 LOC，且引入新依赖 / 新故障面。原 BACKLOG 估算偏低。

D2. **`LAST_VERIFIED` 常量 + boot warn**：startup 时一次性检查
    `Date.now() - LAST_VERIFIED > 180d` → 一行 warn log。不在 hot path，
    不影响 quota 计算路径。

D3. **180 天阈值**：anthropic 价格调整频率历史上每 6-12 个月一次，
    180 天 = 一个 cycle 上限，触发 warn 即 dev 该 review。

D4. **不阻断启动**：warn only，价格仍走 hardcoded 表 → 旧价格但服务
    正常。

## 落地点

**改写**：
- `src/quota/pricing.ts`：加 `LAST_VERIFIED` 常量 + `maybePricingStaleWarn(now?)`
  helper

**新**：
- `src/quota/pricing.test.ts` 加 stale warn case（mock now 在阈值前 /
  后 / 阈值刚到）

**改写**：
- `src/cli/serve.ts`：startup 调一次 `maybePricingStaleWarn()`

## 形式化保证

F1. `maybePricingStaleWarn` MUST 仅在 `now - LAST_VERIFIED > 180d` 时
    输出 warn，其它情况静默。
F2. quota 计算路径 (`priceFor`) MUST NOT 受 stale sentinel 影响（warn
    是 side effect，rate 仍走 hardcoded 表）。
F3. dev 更新 hardcoded rates 时 MUST 同笔 bump `LAST_VERIFIED` 字符串。

## 不做

- 不引 fetch / scrape / cache file / cron 任何 auto-sync 机制
- 不引第三方 pricing npm 包
- 不阻断 startup（warn only）

## 范围估算

| 模块 | LOC |
|---|---|
| pricing.ts (常量 + helper) | ~15 |
| pricing.test.ts (3 case) | ~25 |
| serve.ts (1 行 call) | ~3 |
| **总** | **~43 LOC** |

## Commit 边界

单笔 commit `feat(server): m-pricing-staleness-sentinel — LAST_VERIFIED
+ boot warn (B7)`。

## 关联

- 出处：BACKLOG B7 实现路径转向（原 auto-sync → staleness sentinel）
- 不影响其它 in-flight change
