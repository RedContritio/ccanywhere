## MODIFIED Requirements

### Requirement: 新建 session 携带当前主题

`POST /api/sessions` 的请求 body MUST 含 `webTheme`，取值为
`useEffectiveTheme()` 当前 hook 返回（`'dark'` 或 `'light'`）。这让服务端
按当前 effective theme 给 cc 子进程注入 `COLORFGBG`（见
`openspec/specs/rest-api/spec.md` "POST /api/sessions"）。

UI 层面 effective theme 变化（包括 auto 模式时间触发）后 MUST NOT 重发已存在
session 的 `webTheme`——env 注入仅作用于新 spawn。已存在 session 的主题
切换由后续 reload 机制覆盖（暂未实现）。

### resume 命中已存在 web-session 时的 navigate 行为

`POST /api/sessions { mode: 'resume', sessionId: X }` 当服务端命中已被占用
的 cc-X 时返 `200` + 现有 web-session 行（详见
`openspec/specs/rest-api/spec.md` "POST /api/sessions" 与
`openspec/specs/sessions/spec.md` "resume 唯一性"）。客户端 MUST：

- 不论 server 返 `200` 还是 `201`，从 response body 取 `id` 字段作为
  `currentSessionId`。
- 调 `navigate(/workspace/<id>)`。
  - 若当前 path 已是 `/workspace/<id>`（同 device 二次 resume 同 cc-X 命中
    自己已经在看的 W），react-router-dom v6 默认 navigate 到当前 path 是
    no-op，TerminalView `key={W}` 不变 → 不 unmount → ws 连接保留 → 体感
    "对话框关闭，仍在原终端"。
  - 若不是当前 path（不同 device 或同 device 但当前在别的 W），navigate
    切换到该 W → TerminalView mount → ws connect → 加入 multi-client
    broadcast。
- 200 与 201 schema 一致，client 无需按 status 区分逻辑。

#### Scenario: 新建会话带 webTheme

- GIVEN useEffectiveTheme 返回 `'light'`
- WHEN  用户点击"新建会话"提交
- THEN  `POST /api/sessions` body 含 `"webTheme": "light"`

#### Scenario: 同 device 同 W resume 不重 mount

- GIVEN 用户当前在 `/workspace/W1`，TerminalView 已 mount，ws active
- AND   W1 是由 resume cc-X 创建的
- WHEN  用户在 history 列表点 cc-X 触发新 resume → POST 返 `200` + W1
- AND   client 调 `navigate('/workspace/W1')`
- THEN  react-router 因 path 不变 navigate 是 no-op
- AND   TerminalView `key={W1}` 不变，组件不 unmount / remount
- AND   ws 连接持续保留（不重连）
- AND   用户感知是"对话框关闭，仍在原 session"

#### Scenario: 不同 device resume 走 multi-client broadcast

- GIVEN device A 在 `/workspace/W1`（W1 是 cc-X 的 resume），ws 1 已 active
- WHEN  device B 在 history 点 cc-X resume → POST 返 `200` + W1
- AND   B 的 client 调 `navigate('/workspace/W1')`，TerminalView mount，ws 2 connect
- THEN  ws server `bundle.clients.add(B_sock)`
- AND   B 收到 W1 的当下 screenState snapshot
- AND   后续 PTY 输出同时广播给 A 和 B 的 sock
- AND   A 与 B 都能 input 写到 W1 的 cc 进程（ws-protocol 多 client 广播
        语义）
