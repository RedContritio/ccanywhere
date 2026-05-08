# Proposal: M6 — Web 前端核心（React + xterm.js + 移动端工具栏）

## Intent

到 M5b 为止，ccanywhere 已经有完整的服务端契约，但还没有人能用——只有 REST 与
WebSocket 端点。M6 给浏览器端补齐：登录、项目/session 列表、xterm.js 终端、
移动端虚拟工具栏。完成后用户能从笔记本和手机浏览器实际使用 cc。

## Scope

包含：

- React 18 + Vite 5 前端项目骨架，TypeScript strict。
- 登录页：token 粘贴 + 设备 label，localStorage 持久化。
- 主界面：左侧 session 列表（带状态徽标 + deletedAt 视觉区分），右侧 xterm.js 终端。
- 新建对话框：项目选择 → fresh / resume（resume 时拉历史）。
- xterm.js 集成：snapshot 全量回放、output 增量、resize 联动、断线重连。
- 移动端响应式：< 768px 抽屉式 session 列表 + 底部虚拟工具栏（Esc / Ctrl / Tab / ↑↓←→ + Ctrl 粘性 modifier）。
- 主题三态 `auto` / `light` / `dark`，`auto` 按本地时间自动切（07-19 light、其它 dark），用户可手动覆盖；选择持久化到 localStorage。
- 客户端 Idempotency-Key 生成（POST 时自动带，重试天然安全）。
- 用 `zustand` 管理全局状态（auth、sessions/projects、UI prefs），persist middleware 自动落 localStorage。
- fastify 加 `@fastify/static` 服务前端构建产物。

不包含（保持现状或留 M7/M8）：

- 浏览器 Notification API（M7）。
- Service Worker / PWA / 离线（如做，单独提案）。
- 会话搜索 / 历史 fuzzy filter（保持简单的列表）。
- 历史会话页与设置页（路由保留位置，UI 留 M7/M8）。
- 多用户、共享、协同（产品定位是单用户）。

## Approach

**前端骨架**：用 Vite 创建 `web/` 子目录，独立 `package.json`（避免 React 的
peer 依赖和 Node-only 包冲突）。Vite 的 dev server 走 5173，REST/WS 通过
proxy 指向 ccanywhere 的 fastify。生产构建产出 `web/dist/`，由 fastify
`@fastify/static` 服务在 `/` 下。

**鉴权流**：登录页要求用户粘贴 token，可选填设备 label。提交后在
`Authorization: Bearer ...` 下访问 `/api/projects` 验证；成功则把
`{ token, label }` 存 localStorage。后续请求统一在 fetch wrapper 与 WS URL
中带上 token。

**状态管理**：用 `zustand` 4.x 拆三个独立 store——auth / sessions(+projects) / ui prefs。
持久化（auth、ui prefs）走 zustand 自带 `persist` middleware 直接落 localStorage，
免手写 useEffect。store 在 React 外可访问，让 api wrapper 与 WS 客户端能直接读 token，
不用 prop drilling。多 store（而非单 store + slices）让 auth 与 sessions 互不 import，
依赖关系在 hook 层显式组合。

**xterm.js 集成**：fit / web-links / unicode11 / serialize 四个 addon 必装。
WebSocket 客户端在 mount 时连接、收到 snapshot 全量 `term.write()`；后续
output 帧增量写入；status 帧驱动顶部的状态徽标；resize 通过 `ResizeObserver`
+ debounce 100ms 触发 server resize。

**移动端工具栏**：通过 `matchMedia('(pointer: coarse)')` 或 viewport ≤ 768
判定移动布局。虚拟工具栏作为 fixed 底部，键映射到 xterm 的 `term.input(...)`
（绕过浏览器默认事件），Ctrl 是粘性——点亮后下一个键发 `Ctrl+X` 然后熄灭。

**Idempotency-Key 客户端策略**：每个 POST 在客户端生成 `crypto.randomUUID()`
作为 key 并保留到该用户操作完成（成功 或 fatal 错误）；该操作期间任何重试都用
同一 key。服务端的 deduplication 与客户端的 retry 配合，弱网络下 ⌘ 重试不
新建多余 session。

**部署**：fastify 服务器加 `@fastify/static`，base path `/`，`/api/*` 与
`/ws/*` 路由优先匹配，未匹配的 GET 落到 SPA `index.html`（便于 react-router
做 client-side 路由）。开发期通过 Vite dev server + proxy 跑。
