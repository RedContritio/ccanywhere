# Proposal: M-feedback-diag-enrich — 反馈自动捕获诊断信息

## Intent

`POST /api/feedback` 上线后真实使用了一周，dogfood 反馈记录证明信息密度
不够：14 条反馈里有半数 title 类似"session 问题严重 / 重连后格式乱了 /
还是渲染问题不少"——body 空、ops 仅 1-2 条 renderer 切换。落盘 record
缺少诊断现场，无法定位是哪个 session 的哪个时间点的哪种异常。

最近一条 `2026-05-09T03-02-24-299Z-728cfa3e.json` 是典型：

```
title: "这个 session 问题很严重"
body:  (空)
ops:   6 条 (renderer.dom × 3, session.create × 2)
```

定位线索全无。

本提案给反馈通道补三层自动诊断，让用户提交一个反馈相当于 attach 了
一份"出问题瞬间的现场"。**不要求用户写更多文字**——所有诊断 MUST
是后台自动收集。

## Scope

包含：

- 客户端 diag 收集（viewport / net / app / ws / term-screen / memory）。
- ops-log 增强：覆盖 ws.connect / ws.close / ws.reconnect / ws.frame.error
  / term.write.error / window.unhandledrejection。
- 服务端注入：反馈 body 含 `diag.activeSessionId` 时，server 根据它去
  manager 查 server-side session 状态（state、headSeq、tailSeq、scrollback
  bytes、最近 PTY data ts、PTY exit code），写入落盘 record 的
  `serverSession` 字段；同时附 `serverInfo.commitSha` 与 `serverInfo.uptime`。
- 反馈 dialog 与 ErrorBoundary 都自动收集 diag 并附到 POST body。

不包含：

- 不开新通道（仍走 POST /api/feedback）。
- 不收集任何 PII（用户输入字符级文本不收，只收 viewport/网络/计数）。
- 不上报命令行参数 / env 变量（避免泄漏）。
- 不增加用户感知的字段（不让用户填 sessionId / device 等冗余信息）。

## Approach

**客户端 diag 收集**用一个 module-scoped slot 维持"当前 active terminal +
socket + session"引用：terminal 组件 mount 时调 `setActiveTerm(term, ws,
sessionId)`，unmount 时清空。`collectDiag()` 读 slot 加上无 context 的
viewport / net / memory，返回结构化对象。这样 feedback dialog 与
ErrorBoundary 不需要 prop 传递就能拿到诊断现场。

**term.screen 行级纯文本**用 xterm 自带 API：

```ts
const buf = term.buffer.active;
const start = Math.max(0, buf.viewportY - 20); // 可见区上方 20 行 scrollback
const end = buf.viewportY + term.rows;
const screen: string[] = [];
for (let i = start; i < end; i++) {
  const line = buf.getLine(i);
  screen.push(line ? line.translateToString(true) : '');
}
```

返回 `string[]` 比 SerializeAddon 的 ANSI 字节流可读太多，体积也小（典型
40×40 = ~1.6KB < 2KB）。

**服务端 inject** 改 `registerFeedbackRoutes` 签名加 manager 参数。
body schema 加 optional `diag` 字段（前端不传不影响合法性）；
`diag.activeSessionId` 命中 manager 时从 `session.scrollback.headSeq /
tailSeq` 与 `session.state` 读取注入。manager 不命中时静默跳过 server
inject（反馈仍要落盘——客户端 diag 仍有用）。

`serverInfo.commitSha` 启动时读：先 `process.env.GIT_SHA`（生产环境通过
LaunchAgent EnvironmentVariables 注入），缺失则 `git rev-parse HEAD`
（开发环境）。两者都读不到时用 `'unknown'`。`serverInfo.uptime` 是
`Date.now() - startedAt` 毫秒。

## Out of scope（未来可加）

- 把 diag 接入 cli `ccanywhere feedback ls/show <id>` 浏览器（task #21
  独立 projects 页落地后再说）。
- 服务端把反馈索引到 SQLite / 全文检索：当前 ls 排序+grep 够用。
- 客户端 diag 上传压缩：当前 record JSON 平均 < 5KB，没必要。
