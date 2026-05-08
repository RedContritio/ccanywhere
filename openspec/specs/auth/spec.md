# Auth

## Purpose

ccanywhere 有两个独立的信任域：人类用户（浏览器、移动端、CLI）和 cc 自身回调
其配置的 hooks。两者必须使用不同的 token——这样泄漏一个用户 token 不能伪造
hook 事件，泄漏 hook token 也不能驱动 session。

## Requirements

### Requirement: 双 token 域

服务端 MUST 按以下规则验证认证：

- **用户 token**：来自配置的 `{ label, token }` 数组；用于除 `/api/hook/*` 与
  `/healthz` 之外的所有路由。
- **内部 hook token**：服务启动时生成的单一密钥（32 字节十六进制，不持久化）；
  仅在 `/api/hook/*` 路由上接受。

用户 token MUST NOT 授权 `/api/hook/*`。内部 hook token MUST NOT 授权其它路由。

#### Scenario: 用户 token 在 hook 路由上被拒绝

- GIVEN 用合法用户 token 请求 `POST /api/hook/<sid>/Stop`
- WHEN  服务端处理
- THEN  响应 MUST 为 `401 unauthorized`

#### Scenario: hook token 在用户路由上被拒绝

- GIVEN 用内部 hook token 请求 `GET /api/projects`
- WHEN  服务端处理
- THEN  响应 MUST 为 `401 unauthorized`

### Requirement: token 传输方式

对非 upgrade 的 HTTP 请求，服务端 MUST 同时接受
`Authorization: Bearer <token>` 头与 `?token=<token>` 查询参数。两者并存时 header 优先。

对 WebSocket upgrade 请求（`Upgrade: websocket`），同样规则适用，但因大多数浏览器
WebSocket API 无法设置自定义 header，实际只能用 query 串。

#### Scenario: Bearer header 被接受

- GIVEN `Authorization: Bearer <合法>` 头
- WHEN  访问任意非 hook 路由
- THEN  请求继续

#### Scenario: query token 作为后备被接受

- GIVEN 没有 `Authorization` 头但 URL 含 `?token=<合法>`
- WHEN  访问任意非 hook 路由
- THEN  请求继续

#### Scenario: 缺 token

- GIVEN 既没 `Authorization` 头也没 `?token=`
- WHEN  访问任意非公开路由
- THEN  响应 MUST 为 `401 unauthorized`

### Requirement: 公开路由

`/healthz` MUST 无需认证可达，MUST 返回 `200 { "ok": true }`。其它路由都不公开。

#### Scenario: healthz 公开

- GIVEN 不带 token
- WHEN  `GET /healthz`
- THEN  状态 `200`，body `{"ok": true}`

### Requirement: WebSocket upgrade 拒绝时清理 socket

WebSocket upgrade 请求认证失败时，服务端 MUST 直接写裸 HTTP `401` 响应附
`Connection: close` 并立即销毁底层 TCP socket，不要走框架的 graceful reply
路径。这是为了避免 `app.close()` 被一个挂起的 keep-alive socket 阻塞。

#### Scenario: 错 token 的 upgrade 立刻断连

- GIVEN 一个 WebSocket upgrade 请求带 `?token=wrong`
- WHEN  服务端处理
- THEN  客户端收到 HTTP `401`
- AND   底层 socket 在 1 秒内关闭
- AND   `app.close()` 在正常超时内返回
