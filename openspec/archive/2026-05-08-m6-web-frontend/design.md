# Design

## 仓库布局

```
ccanywhere/
├── src/                     ← 现有 server 代码（不动）
├── web/                     ← M6 新增前端
│   ├── package.json         ← React + xterm + Vite 等
│   ├── vite.config.ts
│   ├── tsconfig.json        ← strict，独立于 server tsconfig
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── app.tsx
│   │   ├── api.ts           ← fetch wrapper + idempotency
│   │   ├── ws.ts            ← WebSocket 客户端（重连、frame 类型）
│   │   ├── auth/
│   │   ├── pages/
│   │   │   ├── login.tsx
│   │   │   └── workspace.tsx
│   │   ├── components/
│   │   │   ├── session-list.tsx
│   │   │   ├── terminal.tsx
│   │   │   ├── new-session-dialog.tsx
│   │   │   └── mobile-toolbar.tsx
│   │   ├── state/
│   │   │   └── context.ts
│   │   └── styles/
│   │       └── *.css
│   └── public/
└── openspec/
```

server 端的 `tsconfig.json` 与 `web/tsconfig.json` 完全独立——前者 target
node20、后者 target ESNext + DOM lib。两边复用的类型（如 `ServerFrame`）通过
**复制**而不是 import 共享：server 的 `src/ws/protocol.ts` 与 web 的
`src/ws.ts` 各自定义同形 union；用单测保证两边形状一致。原因：跨 src/web
的 path mapping 会让 tsconfig、Vite、tsup 三处都得维护一份 alias，回报不值。

## 依赖（web/package.json）

| 包 | 用途 |
|----|------|
| `react` 18.x | UI |
| `react-dom` 18.x | UI |
| `react-router-dom` 6.x | SPA 路由 |
| `zustand` 4.x | 全局状态 + persist middleware |
| `@xterm/xterm` 5.5+ | 终端 |
| `@xterm/addon-fit` | 终端尺寸自适应 |
| `@xterm/addon-web-links` | 终端中链接可点 |
| `@xterm/addon-unicode11` | 中文/emoji 宽度 |
| `@xterm/addon-serialize` | 重连时 scrollback 序列化 |
| `vite` 5.x + `@vitejs/plugin-react` | 构建 |
| `typescript` 5.x | 已有 |
| `vitest` + `@testing-library/react` + `@testing-library/jest-dom` | 测试 |
| `jsdom` | 测试运行环境 |

不引：axios、swr、tanstack query、redux、styled-components、tailwind。

## 状态管理（zustand）

三个独立 store：

```typescript
// state/auth.ts
type AuthState = {
  token: string | null;
  label: string | null;
  verifiedAt: number | null;
  login: (token: string, label: string) => void;
  logout: () => void;
};
const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null, label: null, verifiedAt: null,
      login: (token, label) => set({ token, label, verifiedAt: Date.now() }),
      logout: () => set({ token: null, label: null, verifiedAt: null }),
    }),
    { name: 'ccanywhere.auth' },
  ),
);

// state/sessions.ts (server state, 不持久化)
type SessionsState = {
  projects: Project[];
  sessions: Session[];
  fetchProjects: () => Promise<void>;
  fetchSessions: () => Promise<void>;
};

// state/ui.ts (UI prefs, 持久化)
type UiState = {
  themeMode: 'auto' | 'light' | 'dark';
  currentSessionId: string | null;
  setTheme: (mode: 'auto' | 'light' | 'dark') => void;
  cycleTheme: () => void;
  selectSession: (id: string | null) => void;
};
const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({ ... }),
    { name: 'ccanywhere.ui' },
  ),
);
```

为什么是多 store 而不是单 store + slices：

- auth 与 sessions 在领域上独立——auth 只关心 token，sessions 只关心列表。
  多 store 让两者在 import 层就互不依赖。
- 持久化粒度独立：auth 与 ui prefs 持久化，sessions 不（server-derived，每次拉新）。
- 测试友好：每个 store 可独立 reset (`useAuthStore.setState({...initial})`)。

为什么不引 TanStack Query：sessions / projects 是简单 list，mount 时拉一次 +
用户操作后手动 `fetchSessions()` 刷新即可，不值得引入 cache 抽象层。

## 鉴权流程

登录页：

1. 用户输入 token + label。
2. `fetch('/api/projects', { headers: { Authorization: 'Bearer ...' } })`。
3. 200 → `useAuthStore.getState().login(token, label)`（persist middleware
   自动写 localStorage `ccanywhere.auth`），跳转 `/workspace`。
4. 401 → 显示 "token 无效"。
5. 网络错误 → "服务不可达"。

后续 API 调用都通过 `api.ts` 的 wrapper：
- 从 `useAuthStore.getState().token` 读 token，自动加 Authorization 头。
- 收到 401 → `useAuthStore.getState().logout()`（persist middleware 自动清
  localStorage），跳回 `/login`。
- POST 自动带 `Idempotency-Key`（值由调用方传，否则生成 `crypto.randomUUID()`）。

## API wrapper

```typescript
type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
};

async function api<T>(path: string, opts: RequestOptions = {}): Promise<T>;
```

所有 POST 默认 `crypto.randomUUID()` 当 key——但 UI 层面的"创建 session"
按钮要在用户点击时生成一次 key 并保留：组件级 useRef 持有 key，重试同操作复用。
这样浏览器自动重试（fetch 的内部 retry 不存在，但用户手动点重试）也用同一 key。

## WebSocket 客户端

```
class TerminalSocket {
  constructor(sessionId: string, token: string, handlers: {...});
  send(frame: ClientFrame): void;
  close(): void;
  // 自动重连：指数退避 250ms → 8s
  // 收到 status: dead → 不再重连，触发 onDead
}
```

重连策略：网络断开 → 等指数退避 → 重连同 sessionId → 服务端会重发
snapshot + status，xterm 端 `term.reset(); term.write(snapshot)` 刷新视图。

不缓存"待发送 input"——客户端不持久化输入，断网期间用户敲的字符不会送到。
（前端可在 UI 上禁用输入并显示"重连中"。）

## xterm.js 集成

`<Terminal sessionId={id} />` 组件：

```
useEffect(() => {
  const term = new Terminal({ ... });
  term.loadAddon(new FitAddon());
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon());
  term.open(ref.current);
  fitAddon.fit();

  const sock = new TerminalSocket(sessionId, token, {
    onSnapshot: (data) => { term.reset(); term.write(data); },
    onOutput:   (data) => { term.write(data); },
    onStatus:   (state) => setState(state),
    onClose:    () => setReconnecting(true),
  });

  term.onData((s) => sock.send({ type: 'input', data: s }));
  const ro = new ResizeObserver(debounce(() => {
    fitAddon.fit();
    sock.send({ type: 'resize', cols: term.cols, rows: term.rows });
  }, 100));
  ro.observe(ref.current);

  return () => { ro.disconnect(); sock.close(); term.dispose(); };
}, [sessionId, token]);
```

终端主题随全局主题（见下）切换：light 用白底深字，dark 用黑底浅字。
`COLORFGBG` 服务端按 dark 默认传给 cc 子进程；当前阶段不动态调整 cc 的颜色感知。

## 主题（auto / light / dark）

三态由 `useUiStore.themeMode` 持有：

| 模式 | effective theme |
|------|----------------|
| `auto` | 本地时间 07:00–18:59 → `light`，其它 → `dark` |
| `light` | 强制 `light` |
| `dark` | 强制 `dark` |

默认 `auto`，存 localStorage `ccanywhere.ui`。顶部 header 一个图标按钮
cycle 三态：`auto` → `light` → `dark` → `auto`，按钮显示当前 effective theme
+ 模式角标。

实现：

- `useTheme()` hook：订阅 `themeMode`，读当前时间，计算 effective theme，
  写 `document.documentElement.dataset.theme = "light" | "dark"`。
- 全局 CSS 用属性选择器：`:root[data-theme="dark"] { --bg: #0a0a0a; ... }`，
  浅色一套，暗色一套，组件用 CSS 变量。
- `auto` 模式下 setInterval 每 60 秒重新计算 effective theme，避免天黑/天亮
  时用户要手动刷新。`light` / `dark` 不开 interval。
- xterm.js theme：传 effective theme 对应的颜色对象给 `new Terminal({ theme })`，
  切换时调 `term.options.theme = ...`。

不接 `prefers-color-scheme`：用户已明确"按时间自适应"，与系统时段重叠时容易冲突。
未来若有需要可作为第四种模式 `system` 单独提案。

## 移动端工具栏

判定：CSS `@media (pointer: coarse) and (max-width: 768px)`。命中时显示
`<MobileToolbar>` 固定底部，按钮发送字符到 terminal：

| 按钮 | 字符 |
|------|------|
| Esc | `\x1b` |
| Tab | `\t` |
| Ctrl | （粘性 modifier） |
| ↑    | `\x1b[A` |
| ↓    | `\x1b[B` |
| ←    | `\x1b[D` |
| →    | `\x1b[C` |

Ctrl 粘性：点击后高亮 + 设 `pendingCtrl=true`；下一次任意按键（包括方向键、字母）发送 `Ctrl+X` 字节（`String.fromCharCode(c & 0x1f)`），然后清除 pendingCtrl。

工具栏不抢焦点（用 `pointer-events: auto` 但不 `tabindex`），保证软键盘能弹出。

## SessionList 设计

每条 session 显示：
- 项目名 / 创建时间 / 状态徽标（idle / busy / dead 用颜色）
- `deletedAt !== null` 时整行半透明 + "已删除"标签，仍可点击查看 scrollback

列表按 `createdAt` 倒序。新建按钮在顶部。

## 路由

M6 仅落地核心两条路由；历史会话与设置作为占位路径不实现 UI（fallback 到
`/workspace`），实际页面留 M7/M8 单独提案。

```
/login            # 登录页
/workspace        # 主界面
/workspace/:id    # 主界面 + 选中某个 session
/history          # 占位：M7/M8 实现，目前 redirect 到 /workspace
/settings         # 占位：M7/M8 实现，目前 redirect 到 /workspace
```

react-router-dom v6。未登录访问任意非 `/login` 路径跳到 `/login`。

## 服务端集成

`src/server/server.ts` 加：

```typescript
await app.register(staticPlugin, {
  root: resolve(__dirname, '../web/dist'),
  prefix: '/',
  decorateReply: false,
});
app.setNotFoundHandler((req, reply) => {
  // /api/* 与 /ws/* 已经被各自路由处理，剩下的 GET 当 SPA 入口
  if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws/')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
});
```

`web/dist` 在生产构建后由 `pnpm -F web build` 产出。dev 期间用 Vite 5173 +
proxy `/api` `/ws` 到 fastify。

## 测试策略

| 层级 | 工具 | 覆盖 |
|------|------|------|
| 单元 | vitest + jsdom + RTL | 组件渲染、reducer、api wrapper、idempotency key 生成 |
| 集成 | vitest + jsdom + msw（如需要） | 登录流、新建 session 流 |
| E2E | 不做 | 留 M8 / 后续 |

xterm.js 不能在 jsdom 完整渲染（需要真 DOM）——把 `<Terminal>` 的核心逻辑
拆出 `useTerminalSocket()` hook，hook 里没有 xterm 实例，只有 sock + state，
hook 单测覆盖；`<Terminal>` 组件作为薄壳，单测只验证它创建 + dispose。

## 拒绝的备选方案

- **不引第三方 state 库**：原方案是 React Context + useReducer。改为引 zustand。
  理由：persist middleware 直接落 localStorage（免去手写 useEffect 同步）；多个
  Provider 嵌套读起来累；store 在 React 外可访问让 api/ws wrapper 无需 prop
  drilling。
- **TanStack Query**：sessions/projects 是简单 list，mount 拉一次 + 操作后手
  动 refetch 足矣，不需要 server cache 抽象。
- **monorepo workspace（pnpm workspace）**：可行，但单仓两个 package.json
  + workspace 配置增加新成员的认知负担。直接两个独立 package.json + 各自
  `pnpm install` 更直白。
- **Tailwind CSS**：单页应用 + 不超过 10 个组件，手写 CSS 200 行可控。
- **跟随 `prefers-color-scheme`**：与"按时间自适应"语义冲突，作为第四种模式
  `system` 留作未来扩展。
- **Web Components 替代 React**：用户已选 React，不再讨论。
- **server-side rendering**：客户端是终端 + 实时 WS，SSR 收益接近零。
- **Service Worker 缓存**：M6 不做，手机端只在前端 tab 存活时工作；后台收
  通知是 M7 或更后。
