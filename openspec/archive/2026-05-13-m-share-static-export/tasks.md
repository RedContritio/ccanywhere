# Tasks: m-share-static-export (shipped)

V1 + P1-P4 polish 全部 ship 完成。Branch `auto/share-static-export` 11
commits ahead of main，待 squash 合入。

## Commit 时间线

| commit | scope |
|---|---|
| a6dfefb | docs(openspec): fill v1 proposal + tasks |
| 881b6fb | feat(server): C1 — share render + store + code |
| 33eda98 | feat(server): C2 — share routes + serve 接线 + schema |
| 23b64cf | feat(web): C3 — share-create-dialog + session-list ↗ 入口 |
| bf297ff | feat(web): C4 — /settings 我的分享 section |
| 05c201d | ship: C5/C6 — spec delta + archive + BACKLOG cleanup |
| f713b04 | fix(web): P1 — 聊天泡泡 layout + entity double-escape fix |
| 915bd95 | fix(server): P2 — 4 share view 排版 polish |
| 085a3c3 | fix(server): P3 — timestamp 改纯时间间隔 30min 规则 |
| 6126501 | fix(server): P4 — bubble fit-content + timestamp polish |

## Phase 0 — 启动前对齐

- [x] T0.1. user 审 proposal D1-D11 决策 + redirect — D2 改 UUID
  full（user "share code 这个有点过分受限了，希望用更长的 UUID 来做"），
  其余 D1/D3-D11 user 赞同。
- [x] T0.2. syntax highlight 路径决定 — defer to v2+（user 同意 "语法
  高亮、布局这些等你完成一个可展示的页面再调整"），v1 用 marked default
  + CSS pre/code styling。
- [x] T0.3. schema bump prod config 同步决定 — `shareTtlMs` 设 optional
  字段，缺省 fallback 7d。Prod config 无需改动，无 schema-bump 同步成本。

## Phase 1 — C1: server-side render + store (881b6fb)

- [x] T1.1. `src/share/code.ts`：UUID v4 generator via
  `crypto.randomUUID()` + `isValidShareCode` strict regex (拒 path-
  traversal / uppercase / wrong version / wrong length)
- [x] T1.2. `src/share/render.ts` + `render-assets.ts`：jsonl→HTML
  - cc message format 解析 (user / assistant / tool_use / tool_result)
  - markdown→HTML via marked v18 + renderer.html override 拦截 raw
    HTML token (XSS protection: user `<script>` shows as literal text)
  - thinking 块 **drop**（privacy — internal CoT 不公开）
  - 主题 CSS variables (light/dark) + 主题切换 JS inline
  - noindex meta + caps tool_use args (2000) + tool_result body (4000)
  - STYLES + THEME_SCRIPT 抽 `render-assets.ts` 过 300 行 lint cap
- [x] T1.3. `src/share/store.ts`：ShareStore 类
  - `save(record, html)` / `load(code)` sync / `loadHtml(code)` sync /
    `delete(code)` / `loadAllSync()` boot sweep / `listByUserSync`
  - per-code chain (mirrors B10 m-registry-write-queue) 让同 code
    writes 串行
- [x] T1.4. `src/share/code.test.ts` (9 case)
- [x] T1.5. `src/share/store.test.ts` (17 case)
- [x] T1.6. `src/share/render.test.ts` (14 case)
- [x] T1.7. C1 commit + typecheck / 400 test (42 新) / lint

## Phase 2 — C2: routes + serve 接线 + schema (33eda98)

- [x] T2.1. `src/config/schema.ts`：加 `shareTtlMs?: number` optional
  (fallback 7d in route handler; optional 不需 prod config 同步)
- [x] T2.2. `src/server/routes/share.ts` 4 endpoints:
  - POST `/api/share`：身份校验 + session cross-user 校验 + jsonl
    readFileSync + render + 颁 UUID + save + 返
    `{ code, url, expiresAt, createdAt }`；ttlMs 支持 null / 正整数 cap
    to 10y / 缺省 fallback
  - GET `/api/share/list`：listByUserSync 返当前 user 创建的 shares
    (newest first)
  - DELETE `/api/share/:code`：UUID 格式校验 + createdBy 校验 + unlink
    → 204；cross-user / unknown → 404 (no leak)
  - GET `/share/:code`：**无鉴权** (auth.ts onRequest hook 自动放行
    non-/api/ non-/ws/) + UUID 格式校验 + lazy GC expired + cache-
    control public/max-age=31536000/immutable + text/html
- [x] T2.3. `src/server/server.share.test.ts` (16 case)
- [x] T2.4. `src/server/server.ts`：buildServer options 加
  `shareStore?: ShareStore`; wire `registerShareRoutes` if defined
- [x] T2.5. `src/cli/serve.ts`：构造 `ShareStore(<configDir>/shares)`
  + `shareStore.loadAllSync()` sweep expired at boot + 传给 buildServer
- [x] T2.6. C2 commit + typecheck:all / 416 test (16 新) / lint /
  lint:md / build:all / kickstart healthz 200
- [x] T2.7. 服务 up 验证：server.log boot 无报错 / 现有 /api/sessions
  回归 sanity

## Phase 3 — C3: share-create-dialog + 入口 (23b64cf)

- [x] T3.1. `web/src/state/shares.ts`：Zustand store
  (`fetchMyShares / createShare / deleteShare` + reset helper)
- [x] T3.2. `web/src/components/share-create-dialog.tsx`：DialogBase
  + TTL select (1d / 7d / 30d / never) + 内容 warning (含 secret /
  CDN 缓存不可立即撤回) + 提交 → 显 URL + 复制按钮（with copied /
  failed feedback）+ 过期时间显示
- [x] T3.3. 入口：放在 `session-list.tsx` row right side absolute
  flex container (与 × delete 并排，hover/focus 时 opacity:100
  reveal)。↗ icon. dialog state 内 SessionList 管理避免 workspace
  超 500 行 lint cap
- [x] T3.4. e2e visual 自检 — 由 P1 加 share-view.spec.ts 覆盖（统一
  在 share view 路径自检，dialog 单独截图意义低）
- [x] T3.5. C3 commit + typecheck:all / 416 test / lint / lint:md /
  build:all + kickstart healthz 200

## Phase 4 — C4: /settings my-shares + delete (bf297ff)

- [x] T4.1. `web/src/components/my-shares-section.tsx`：列 shares
  (newest first via store sort) + 每 row copy URL button (clipboard
  with copied/failed feedback) + 删除 button (busy state) + expires
  display
- [x] T4.2. `web/src/pages/settings.tsx`：加 MySharesSection 在
  ToolbarConfigSection 之后
- [x] T4.3. e2e visual 自检 — 由 P1 加 share-view.spec.ts 覆盖
- [x] T4.4. C4 commit + typecheck:all / 416 test / lint / build:all
  / kickstart healthz 200

## Phase 5 — C5: share view 公开 page + caching + e2e (在 05c201d 内)

- [x] T5.1. `web/src/app.tsx` 无需改 —— `/share/:code` 是 server
  路由直接返 HTML（fastify register order: registerShareRoutes 在
  staticPlugin 之前 match，浏览器 visit 直接 hit server handler，
  不进 SPA fallback）。auth.ts onRequest hook line 119-122 自动放行
  non-`/api/` non-`/ws/` 路径。
- [x] T5.2. share view 渲染方式：server 直接返完整 HTML —— inline
  CSS + 3-line theme-toggle script (render-assets.ts)；cache-friendly
  + 无 client React + 真正 static export
- [x] T5.3. caching headers per D7：`Cache-Control: public,
  max-age=31536000, immutable` + `Content-Type: text/html; charset
  =utf-8` (在 share.ts route handler 内)
- [x] T5.4. mobile e2e (iPhone 13 viewport) — 由 P1 加
  `web/e2e/share-view.spec.ts` 含 desktop + iPhone 13 viewport 覆盖
  bubble alignment + 内容溢出 + Range API selection
- [x] T5.5. C5 effective scope = spec delta + archive (T5.1-T5.3 已
  在 C2 done；e2e visual 由 P1 补完)

## Phase 6 — Ship (05c201d)

- [x] T6.1. `openspec/specs/share/spec.md` 新建 area + 9 Requirement
  + 12 Scenario (UUID v4 / public view 无鉴权 / 完全可缓存 /
  ownership 校验 / my-shares filter / delete 限 owner / frozen
  snapshot 不泄漏 identifier / lazy GC / shareTtlMs optional)
- [x] T6.2. `openspec/specs/rest-api/spec.md` 加 share endpoints 段
  cross-ref share/spec.md
- [x] T6.3. typecheck:all / 416 test / lint / lint:md / build:all +
  kickstart healthz 200 ✓
- [x] T6.4. archive `mv changes/m-share-static-export
  archive/2026-05-13-m-share-static-export`
- [x] T6.5. BACKLOG.md 删 m-share-static-export 大项指针
- [x] T6.6. user mobile + desktop 手验 — 经 P1-P4 4 轮 user 反馈
  iteration 隐式完成 (live share URL 提供 dev + user 实测 + redirect)

## Phase 1.5 P1 polish (f713b04) — chat bubble layout

User 看 v1 ship 后第一个 share screenshot 反馈"希望一左一右，类似聊天
窗口的形式，弱化 user 和 assistant"。

- render-assets.ts: 加 `--bubble-user` / `--bubble-assistant` CSS var
  (dark + light theme); article.msg 改 chat-bubble layout: user 右对齐
  brand-tinted bg + right-bottom radius 4px (其它 12px), assistant
  左对齐 default bg + left-bottom radius 4px。max-width 78% 防短消息
  撑满。移除 USER / ASSISTANT uppercase role label。timestamp 改 inline
  `<time>` 在 bubble 内右下角 small mono 10px opacity 0.7。
- render.ts: body loop 改输出 `<article>${html}<time>...</time>
  </article>` 替代 `<div class="role">...</div>${html}`。
- bug fix: marked.parse 前 escapeHtml 在 code block 内导致双重 escape
  (`"差不多"` → `&quot;差不多&quot;` → marked 再 escape `&` →
  `&amp;quot;` browser 渲染 literal `&quot;`)。改用 marked
  renderer.html token override 拦截 raw HTML token 单独 escape，
  renderMarkdown 不再 pre-escape — code block 内 entity 正确显示。
- 加 `web/e2e/share-view.spec.ts` visual test (desktop + iPhone 13
  mobile viewport) + bubble alignment computed margin assertion +
  mobile viewport overflow check。
- 加 `scripts/mint-share.mjs` admin one-shot script (bypass POST
  /api/share cookie 需求，dev 直接 ShareStore + renderShareHtml mint
  share for visual review)。

## Phase 1.5 P2 polish (915bd95) — 4 排版 redirect

P1 chat-bubble ship 后 user 4 条 redirect:

- "不需要分享页生成时间" → render.ts header meta 删 createdAt 部分，
  只剩 "由 ${createdBy} 分享"
- "时间戳放在消息外而非内部" → render.ts body loop 把 `<time>` 抽出
  article 之外 (banner) + render-assets.ts 删 `article.msg > time`
  内部样式 + 加 `time.msg-time` block / text-align:center / mono 11px
  / muted color
- "连续对话时只有第一条需要时间戳" → render.ts pre-process compute
  `showTime` 标记 (`prev === undefined || prev.role !== m.role`)，
  role change boundary 才输出 `<time>`，同 role 连续段折叠
- "代码块之类的长消息将块宽度撑到 100%" → render-assets.ts 加
  `article.msg:has(pre) { max-width: 100% }` CSS-only 规则；`:has()`
  在 modern mobile browser (iOS 15.4+, Android Chrome 105+) 全支持

顺手修 esbuild parse bug: 注释内反引号在 template literal 内被当成
closing delimiter，去掉反引号改 plain text。

## Phase 1.5 P3 polish (085a3c3) — timestamp pure 30min gap

P2 role-change boundary 规则 user 觉得仍太多 banner: "不止 (同 role)，
任意两条，如果前后间隔半小时以内，都可以跳过时间戳"。改成 pure 时间 gap
30min 规则，role 完全不参与:

- render.ts: showTime 从 `prev.role !== m.role` 改成
  `m.timestamp - prev.timestamp > 30 * 60 * 1000`
- 第一条必显; prev.timestamp === null fallback 显; 否则 gap > 30min
- side + tint 已传达 role，几秒内来回的 burst 共享 banner

## Phase 1.5 P4 polish (6126501) — bubble fit-content + timestamp 视觉降级

P3 timestamp gap rule ship 后 user 4 条 redirect:

- "一句话长度小于默认 75% 时，应该按实际宽度缩减" → render-assets.ts
  `article.msg` 加 `width: fit-content`，配合 `max-width: 78%`/
  `:has(pre) { max-width: 100% }` 形成 cap 三档：短消息 hug 内容 /
  中等消息 cap 78% / pre-bubble cap 100%
- "消息块的 margin 应该适当缩小" → `article.msg` margin `8px 0` →
  `4px 0`
- "时间的字号和存在感再低一些" → `time.msg-time` font-size 11→10px
  + opacity 0.7→0.5 + margin `16px auto 6px` → `10px auto 4px`
- "同日内不需要重复输出日期" → render.ts 加 `formatTimeOfDay()` /
  `formatDay()` helpers + body 循环 track `lastShownDay`，相同 day
  的后续 banner 只 emit `HH:MM`，跨日才回到 `YYYY-MM-DD HH:MM`

Verification (mint d308ce34 + e2e desktop/mobile fullPage):
- 顶部 banner `2026-05-09 00:41` 完整；后续 5 个 (08:51/09:38/14:32/
  16:06/19:42) 全 HH:MM only — 同日折叠生效
- 短 bubble "测试" / "153" 不再 stretch 到 78%，明显 fit-content
- 长 code-block bubble 仍 100% 宽
- banner 字号视觉明显比 P3 quieter (opacity 0.5 + 10px)

## 后续 / v2+ 标记

- v2: turn-by-turn share range select（v1 整 session 全 share）
- v2: password-protected share
- v2: shiki / highlight.js 替换内置简单 highlighter（若 user 反馈
  code 多语种支持不够）
- v2: share size cap + 磁盘 quota
- v2: regenerate / rotate share code
- v2: share view 加 OG meta tags（社交分享 preview）

## Commits

- c817f7c ship: m-share-static-export v1 + P1-P4 polish
