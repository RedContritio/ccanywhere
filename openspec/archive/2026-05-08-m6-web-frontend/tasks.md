# Tasks

## 1. web/ 前端骨架

- [ ] 1.1 创建 `web/package.json`（独立于 root），声明 React / Vite / xterm / zustand / react-router-dom 等依赖
- [ ] 1.2 `web/tsconfig.json`：target ESNext、lib DOM + ES2022、strict 全开
- [ ] 1.3 `web/vite.config.ts`：proxy `/api` `/ws` → `127.0.0.1:7878`；构建产 `dist/`
- [ ] 1.4 `web/index.html` + `web/src/main.tsx` 最小渲染
- [ ] 1.5 `web/src/styles/reset.css` + 暗色主题基础
- [ ] 1.6 `pnpm -C web install` + `pnpm -C web dev` 跑通

## 2. API & WS 客户端

- [ ] 2.1 `web/src/api.ts`：fetch wrapper，401 → 清 localStorage 跳登录；POST 自动 `Idempotency-Key`
- [ ] 2.2 `web/src/ws.ts`：`TerminalSocket` 类，含指数退避重连、frame 解码、handler 接口
- [ ] 2.3 `web/src/api.test.ts`：mock fetch，验证 header、401 流、idempotency 透传
- [ ] 2.4 `web/src/ws.test.ts`：mock WebSocket，验证重连退避、状态切换、frame parse 错处理

## 3. zustand store + 登录页

- [ ] 3.1 `web/src/state/auth.ts`：`useAuthStore`，含 token/label/verifiedAt + login/logout，persist 中间件
- [ ] 3.2 `web/src/state/sessions.ts`：`useSessionsStore`，含 projects/sessions + fetchProjects/fetchSessions
- [ ] 3.3 `web/src/state/ui.ts`：`useUiStore`，含 themeMode/currentSessionId + setTheme/cycleTheme/selectSession，persist
- [ ] 3.4 `web/src/state/auth.test.ts`、`ui.test.ts`：reducer 行为 + persist key 一致性
- [ ] 3.5 `web/src/pages/login.tsx`：token + label 输入，提交调 `/api/projects`，成功调 `useAuthStore.login`
- [ ] 3.6 失败态文案：401 / 网络错 / 服务 5xx 区分

## 4. Workspace 主界面

- [ ] 4.1 `web/src/pages/workspace.tsx`：左右两栏布局，react-router-dom 接入
- [ ] 4.2 `web/src/components/session-list.tsx`：状态徽标 + deletedAt 视觉区分 + 选中态
- [ ] 4.3 `web/src/components/new-session-dialog.tsx`：项目下拉 + fresh/resume 切换 + history list
- [ ] 4.4 `web/src/components/terminal.tsx`：xterm.js + addons 集成；通过 `useTerminalSocket` hook 解耦
- [ ] 4.5 顶部状态条：当前 session 名 + state + 重连指示
- [ ] 4.6 `web/src/components/theme-toggle.tsx`：图标按钮 cycle auto/light/dark
- [ ] 4.7 `web/src/styles/themes.css`：light/dark 两套 CSS 变量 + `:root[data-theme]` 切换
- [ ] 4.8 `web/src/state/use-theme.ts`：hook 计算 effective theme 写 `data-theme`，auto 模式下 setInterval 每 60s 重算
- [ ] 4.9 路由占位：`/history`、`/settings` redirect 到 `/workspace`

## 5. 移动端响应式 + 工具栏

- [ ] 5.1 `web/src/components/mobile-toolbar.tsx`：Esc / Tab / Ctrl(粘性) / ↑↓←→
- [ ] 5.2 `web/src/styles/responsive.css`：< 768px 抽屉化 session list；toolbar 固定底
- [ ] 5.3 工具栏不抢焦点（不阻断软键盘）；按钮按下立即发字符到 terminal
- [ ] 5.4 Ctrl 粘性单测：点 Ctrl + 'C' 发 `\x03`

## 6. server 端集成

- [ ] 6.1 `pnpm add @fastify/static` 到 root
- [ ] 6.2 `src/server/server.ts` 注册 staticPlugin，root 指向 `web/dist`，SPA fallback
- [ ] 6.3 仅在 web/dist 存在时注册（dev 期间不注册，避免 dev server 与 staticPlugin 冲突）
- [ ] 6.4 server.test.ts 增 1 个测试：构建产物存在时 GET / 返回 index.html

## 7. 构建与部署

- [ ] 7.1 `pnpm -C web build` 产出 `web/dist/`
- [ ] 7.2 root `package.json` 加 `build:all` 脚本：先 web 后 server
- [ ] 7.3 `.gitignore` 添加 `web/node_modules/`、`web/dist/`

## 8. spec 归档

- [ ] 8.1 全套测试通过（root + web）
- [ ] 8.2 把 `changes/m6-web-frontend/specs/` 合并进 `openspec/specs/`，新增 `web-frontend/spec.md`
- [ ] 8.3 移到 `archive/YYYY-MM-DD-m6-web-frontend/`
- [ ] 8.4 commit "M6: web frontend (React + xterm.js + mobile toolbar)"

## Commits

- (no matching commits found in git log)
