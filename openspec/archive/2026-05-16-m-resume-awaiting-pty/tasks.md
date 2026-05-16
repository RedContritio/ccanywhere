# Tasks

## 段 1：ws.ts onFirstData

- [ ] T1.1 `SocketHandlers` 加 `onFirstData?: () => void`
- [ ] T1.2 `TerminalSocket` 加 `private firstDataDelivered = false`
- [ ] T1.3 `dispatch` 在 snapshot / output case 处理前若 `!firstDataDelivered` → set true + 调 `handlers.onFirstData?.()`
- [ ] T1.4 reconnect 不 reset latch（latch 是 socket 实例字段，重连不重建实例）

## 段 2：terminal layer 转发

- [ ] T2.1 `terminal-socket-setup.ts` `TerminalSocketHandlers` 加 `onFirstData`；wire 到 `TerminalSocket` 构造
- [ ] T2.2 `terminal.tsx` `Props` 加 `onFirstData?: () => void`；handlersRef 自动转发

## 段 3：wsConnLabel 加 awaiting

- [ ] T3.1 `wsConnLabel` 签名加可选 `awaitingData?: boolean`
- [ ] T3.2 `connected && awaitingData` → `'已连接，等待 cc 输出…'`
- [ ] T3.3 其他分支不变

## 段 4：workspace.tsx 接线

- [ ] T4.1 加 `const [awaitingFirstData, setAwaitingFirstData] = useState(true)`
- [ ] T4.2 useEffect([id]) reset 加 `setAwaitingFirstData(true)`
- [ ] T4.3 加 `onWsFirstData = useCallback(() => setAwaitingFirstData(false), [])`
- [ ] T4.4 TerminalView 传 `onFirstData={onWsFirstData}`
- [ ] T4.5 wsConnLabel 调用传第 3 参 `awaitingFirstData`

## 段 5：测试

- [ ] T5.1 `ws.test.ts`：snapshot 首次触发 onFirstData / output 首次触发 / 第二次不再触发 / status 不触发
- [ ] T5.2 `ws-conn-label.test.ts`：`connected + awaitingData=true` 返回新 label；`connected + awaitingData=false` 仍 "已连接"；其他 conn 状态忽略 awaitingData

## 段 6：Build & Deploy

- [ ] T6.1 `pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm test` 全绿
- [ ] T6.2 `pnpm build:all`
- [ ] T6.3 `launchctl kickstart -k`；`curl -sf /healthz` 200
- [ ] T6.4 bundle 验证：`curl -s /assets/index-*.js | grep "等待 cc 输出"` 应命中（确认新 label 字符串进了 bundle）

## 段 7：BACKLOG + Commit + Archive

- [ ] T7.1 `openspec/BACKLOG.md` 删 B18 条目
- [ ] T7.2 commit（含 archive 路径，无 spec delta——纯 UX 中间态补完）
- [ ] T7.3 `mv openspec/changes/m-resume-awaiting-pty openspec/archive/<date>-m-resume-awaiting-pty`
