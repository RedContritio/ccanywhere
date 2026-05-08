# Web Frontend

## Purpose

ccanywhere 的服务端只提供 REST 与 WebSocket 端点；要让人在浏览器里用，需要一个
独立的前端项目。这个 capability 描述 `web/` 子目录下的 React + Vite SPA：
登录流、workspace 主界面、session 列表与新建对话框、xterm.js 终端、移动端
虚拟工具栏、主题（auto/light/dark）切换、客户端 Idempotency-Key 策略，以及
react-router 路由约定。

## Requirements

### Requirement: 前端入口与构建

ccanywhere 仓库 MUST 在 `web/` 子目录下提供一个独立的 React + Vite 前端项目。
该项目 MUST：

- 使用 TypeScript strict 模式（与 server tsconfig 独立）。
- 用 Vite 构建，产物输出到 `web/dist/`。
- dev 期间 Vite 5173 端口 + 代理 `/api`、`/ws` 到 fastify 监听端口。
- 不引入 monorepo workspace 配置（独立 `package.json` 与 `node_modules`）。

#### Scenario: 开发模式可访问

- GIVEN ccanywhere server 运行在 62275，`pnpm -F ccanywhere-web dev` 启动
- WHEN  浏览器访问 `http://localhost:5173/login`
- THEN  登录页正常加载
- AND   页面对 `/api/projects` 的请求被 Vite proxy 到 62275

### Requirement: 登录与持久化

前端 MUST 在用户首次访问时显示登录页，要求输入：

- `token`（必填）：服务端配置中的某个用户 token 字面值。
- `label`（可选）：本设备的人类可读标签，仅本地用，不上传服务端。

提交后 MUST 调用 `GET /api/projects` 验证：

- 200 → 把 `{ token, label, verifiedAt }` 写入 `localStorage["ccanywhere.auth"]`，
  跳转 `/workspace`。
- 401 → 显示"token 无效"，不写 localStorage。
- 网络错误或 5xx → 显示"服务不可达"。

后续会话内 MUST 在所有 `/api/*` 请求中自动加 `Authorization: Bearer <token>`，
在所有 `/ws/sessions/:id` 连接中加 `?token=<token>`。

收到 `401` 响应时 MUST 立即清 `localStorage["ccanywhere.auth"]` 并跳回登录页。

#### Scenario: 401 触发登出

- GIVEN 用户已登录，token 在配置中被移除
- WHEN  前端发出任何 `/api/*` 请求
- THEN  收到 401
- AND   localStorage 被清空
- AND   页面跳到 `/login`

### Requirement: Idempotency-Key 客户端策略

前端 MUST 为每个 `POST /api/sessions` 调用自动生成 `Idempotency-Key`，
值为 `crypto.randomUUID()`。同一 UI 操作（用户点击"新建对话"按钮一次）
内的所有重试 MUST 复用同一 key——重试时 server 命中缓存返回相同结果。

key 在该操作完成（成功或 fatal 错误）后失效，下次操作生成新 key。

#### Scenario: 重试用同一 key

- GIVEN 用户在新建对话框点击"创建"，第一次请求超时
- WHEN  用户点击"重试"
- THEN  第二次请求带的 `Idempotency-Key` 与第一次相同
- AND   服务端返回 `Idempotency-Replayed: true`
- AND   仅创建了一个 session

### Requirement: Session 列表与 deleted 视觉

主界面 MUST 显示当前 token 视角下的所有 session（来自 `GET /api/sessions`），
按 `createdAt` 倒序。每条目 MUST 显示：

- 项目名（由 projectId 在客户端缓存的 projects 中查找）
- 创建时间（人类可读相对时间）
- 状态徽标（colored chip：idle 绿、busy 黄、dead 灰）
- 若 `deletedAt !== null`：整行半透明，附"已删除"标签，仍可点击查看
  scrollback 历史。

#### Scenario: 软删除的 session 仍可见

- GIVEN 用户对某 session 调过 DELETE
- AND   该 session 在服务端 `deletedSessionTtlMs` 内未被 GC
- WHEN  用户回到主界面
- THEN  session 行仍出现在列表中
- AND   行视觉上明显区别（半透明 + 标签）

### Requirement: 终端视图

主界面 MUST 在右侧渲染一个 xterm.js 终端，绑定到当前选中的 session。组件
挂载时 MUST：

1. 通过 `/ws/sessions/:id?token=<token>` 建立 WebSocket。
2. 收到 `snapshot` 帧 → `term.reset(); term.write(data)`。
3. 收到 `output` 帧 → `term.write(data)`。
4. 收到 `status` 帧 → 更新顶部状态徽标。
5. 收到 `error` 帧 → 在终端最下方显示一条提示，连接保持。
6. 用户键盘输入 → 发 `{ type: "input", data }`。
7. `ResizeObserver` debounce 100ms 触发 `fit()` + 发 `{ type: "resize", cols, rows }`。

addons MUST 包含 fit、unicode11（中文/emoji 宽度）、web-links（URL 可点）。

WebSocket 断开时 MUST 自动重连，指数退避：250ms → 500ms → 1s → 2s → 4s →
8s 然后保持 8s 间隔。session `state == 'dead'` 后 MUST 停止重连并提示用户。

#### Scenario: 重连后视图恢复

- GIVEN 用户在终端中执行命令 producing 多行输出
- WHEN  网络短暂断开后恢复
- THEN  WebSocket 自动重连
- AND   终端通过新到的 `snapshot` 帧恢复完整内容（无残留旧数据）

### Requirement: 移动端虚拟工具栏

当 viewport 满足 `pointer: coarse OR max-width: 768px` 时，前端 MUST 在
终端下方显示固定虚拟工具栏，至少包含按键：

- `Esc` → 发 `\x1b`
- `Tab` → 发 `\t`
- `Ctrl`（粘性 modifier）
- 方向键 `↑ ↓ ← →` → 发对应 ANSI escape

`Ctrl` 粘性：点击后视觉高亮 + 进入"等待下一键"状态；下一次按键（无论是工具栏
按钮还是软键盘字符）发送 `Ctrl+<key>` 即字节 `key.charCodeAt(0) & 0x1f`，然后
退出 Ctrl 状态。

工具栏 MUST 不抢焦点（不让软键盘消失）。

#### Scenario: Ctrl + C 发 0x03

- GIVEN 移动端工具栏可见
- WHEN  用户点 `Ctrl`，然后通过软键盘输入 `c`
- THEN  WebSocket 收到 `{ type: "input", data: "\x03" }`
- AND   `Ctrl` 按钮高亮在 `c` 输入后清除

### Requirement: 主题（auto / light / dark）

前端 MUST 提供三态主题：

| 模式 | effective theme |
|------|----------------|
| `auto` | 本地时间 07:00–18:59 用 `light`，其它时段用 `dark` |
| `light` | 强制 `light` |
| `dark` | 强制 `dark` |

默认 `auto`，持久化到 localStorage（与其它 UI prefs 共用 `ccanywhere.ui`）。

主题切换 UI MUST：

- 顶部 header 含一个图标按钮，单击 cycle `auto` → `light` → `dark` → `auto`。
- 按钮 MUST 显示当前 **effective** theme 的图标 + 当前 **mode** 的角标
  （区分"现在是亮"和"模式是 auto"）。

实现 MUST：

- 把 effective theme 写到 `document.documentElement.dataset.theme`，CSS 用
  `:root[data-theme="dark"]` 形式定义两套 CSS 变量。
- xterm.js 主题与全局主题保持一致——effective theme 切换时同步更新
  `term.options.theme`。
- `auto` 模式下每 60 秒重新计算 effective theme，覆盖天黑/天亮无须手动刷新；
  `light` / `dark` 不开此 interval。

#### Scenario: auto 模式按时切换

- GIVEN themeMode 为 `auto`，本地时间 07:30
- WHEN  界面渲染
- THEN  `document.documentElement.dataset.theme === "light"`
- AND   xterm.js 使用浅色主题

#### Scenario: 用户手动覆盖

- GIVEN themeMode 为 `auto`，effective 为 `dark`
- WHEN  用户点切换按钮一次（cycle 到 `light`）
- THEN  themeMode 更新为 `light`
- AND   effective theme 立即变为 `light`，与本地时间无关
- AND   localStorage `ccanywhere.ui` 反映 `themeMode === "light"`

#### Scenario: 重启浏览器后保持选择

- GIVEN 用户上次选择 `dark` 模式
- WHEN  关闭并重新打开浏览器，访问应用
- THEN  themeMode 从 localStorage 恢复为 `dark`

### Requirement: 路由

前端 MUST 使用 `react-router-dom` v6，至少包含以下路由：

| 路径                    | 行为 |
|-------------------------|------|
| `/login`                | 登录页 |
| `/workspace`            | 主界面，session 未选中 |
| `/workspace/:id`        | 主界面 + 选中某 session |
| `/history`              | 占位（M7/M8 实现），目前 redirect 到 `/workspace` |
| `/settings`             | 占位（M7/M8 实现），目前 redirect 到 `/workspace` |
| 其它任意路径             | 重定向到 `/workspace` 或 `/login`（视登录态） |

未登录访问任何非 `/login` 路径 MUST 跳到 `/login`。
