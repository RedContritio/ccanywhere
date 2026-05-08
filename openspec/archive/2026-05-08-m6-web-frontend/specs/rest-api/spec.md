## ADDED Requirements

### Requirement: 静态资源服务（SPA 入口）

服务端 MUST 在 `web/dist/` 存在时注册 `@fastify/static`，把该目录挂在
HTTP root（`/`）。

未匹配任何 `/api/*` 与 `/ws/*` 路由的 GET 请求 MUST 返回 `web/dist/index.html`，
让 client-side 路由（react-router-dom）接管。其它方法的未匹配请求仍 404。

`web/dist/` 不存在时（例如纯后端开发或镜像未包含前端构建产物），服务端 MUST
仍能正常启动，仅 `/`、SPA 路径返回 404 with 标准 envelope。

#### Scenario: 构建产物存在时 GET / 返回 index.html

- GIVEN `web/dist/index.html` 存在
- WHEN  `GET /`
- THEN  状态 `200`
- AND   响应 body 是 `index.html` 的内容
- AND   `Content-Type` 包含 `text/html`

#### Scenario: 未知 SPA 路径回落到 index.html

- GIVEN `web/dist/index.html` 存在
- WHEN  `GET /workspace/abc-123`
- THEN  状态 `200`
- AND   响应 body 是 `index.html`

#### Scenario: 构建产物缺失不影响后端

- GIVEN `web/dist/` 不存在
- WHEN  服务端启动
- THEN  服务端正常监听
- AND   `GET /api/projects` 与 `/ws/sessions/:id` 仍正常工作

#### Scenario: 静态资源不影响 API 优先级

- GIVEN `web/dist/index.html` 存在
- WHEN  `GET /api/projects` 带合法 token
- THEN  状态 `200`，响应 body 是 JSON（不是 index.html）
