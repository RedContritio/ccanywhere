# Tasks: m-share-button-mobile-visibility (shipped)

- [x] Root cause 定位（feedback 触发：Xiaomi 17 Pro `2026-05-14T06-36-30-
      308Z`）
- [x] `web/src/components/session-list.tsx:92` className 调整 mobile 常驻
- [x] e2e regression `web/e2e/visual.spec.ts` mobile case 新增 + 通过
- [x] 截图 `test-results/visual-session-row-actions-mobile.png` 验证按钮
      在 mobile drawer 中可见（不需 hover）
- [x] 必跑序列：typecheck + lint + lint:md + test（root 416 + web 132
      passed）+ build:all + launchctl kickstart + curl healthz 200 +
      bundle 含 `max-md:opacity-100`
- [x] commit + archive 记录
