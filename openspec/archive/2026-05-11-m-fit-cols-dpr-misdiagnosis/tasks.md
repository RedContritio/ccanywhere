# Tasks: M-fit-cols-dpr

整体 design 见 `proposal.md`。

## Phase 1: 重现 + 定位

- [ ] T1. user 在浏览器开 `?renderer=dom` 触发一次反馈（dom renderer 下的
  cols/rows 进 ops 上报）
- [ ] T2. user 在浏览器开 `?renderer=canvas` 触发一次反馈（canvas 是
  webgl 的中间形态对比）
- [ ] T3. 三个 renderer 数据对比，定 root cause：
  - dom 算对 + webgl/canvas 算错 → A：webgl/canvas atlas 与 fit 互动 bug
  - 三个都错 → B/C：容器测量本身的问题（CSS 或 dom 几何）
- [ ] T4. dev tools console 抓一次 active 状态下的实际值：
  - `document.querySelector('.terminal-view').getBoundingClientRect()`
  - `document.querySelector('.terminal-view-pane').getBoundingClientRect()`
  - 对比 windowInnerWidth + drawer 状态

## Phase 2: 修复

按 phase 1 结果分支：

### Branch A：webgl atlas bug

- [ ] T5. grep `@xterm/addon-fit` 当前版本，看 changelog 是否有 dpr 相关 fix
- [ ] T6. patch `proposeDimensions` 或绕开：在 webgl 高 dpr 时直接用
  `fontSize × CHARWIDTH_RATIO` 算 cellWidth，不走 atlas-derived 路径
- [ ] T7. test：在 dpr 3.25 / 2.0 / 1.5 / 1.0 各算一次，cols 必须 ≈ container CSS-px / cellWidth

### Branch B/C：CSS / 几何

- [ ] T5'. 改 `.terminal-view { box-sizing: border-box }`（或显式锁 `width: calc(100% - padding)`）
- [ ] T6'. inspect `.terminal-view-pane` 实际 boundingRect，verify 占满 `.terminal-host`
- [ ] T7'. 移除 重复 `.terminal-view` 选择器（line 889 / 949 合并）

## Phase 3: 验证

- [ ] T8. 在 Xiaomi 17 Pro（375 css-px 视宽）dogfood 反馈一次，
       cols ≈ 47 / rows ≈ 53
- [ ] T9. PC 1920 × 1080 上反馈一次，cols 仍正确（无回归）
- [ ] T10. 切 renderer 三遍验证一致

## 与其它 task 关系

- 与 #44 m-multi-user 并行（不阻塞 #44 chunk 2）
- 不影响 m-lint-cap 已 ship 状态

## Commits

- (no matching commits found in git log)
