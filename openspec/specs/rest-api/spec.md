# REST API

## Purpose

REST API 是控制面：web 客户端通过它发现项目、列举/创建/删除 session、
浏览历史 cc session 用于 resume。基于 fastify、纯 JSON、错误使用统一 envelope。

## Requirements

### Requirement: 错误 envelope

每个非 2xx 响应 MUST 形如：

```json
{ "error": { "code": "<machine_code>", "message": "<人类可读>" } }
```

`code` 是稳定的 lowercase snake_case 标识符。允许追加额外字段（例如校验失败时
的 `issues`），但 MUST NOT 替代 `code` 与 `message`。

#### Scenario: 未知路由返回标准 envelope

- GIVEN `GET /api/nope` 带合法 token
- WHEN  服务端处理
- THEN  状态 `404`
- AND   body 等于 `{"error": {"code": "not_found", "message": "route not found"}}`

### Requirement: GET /api/projects

返回配置的项目白名单。

```
200 { "projects": [ { "id", "name", "cwd" }, ... ] }
```

响应 MUST 按配置顺序列出**所有**项目。系统是单用户的，不做用户级过滤。

### Requirement: GET /api/projects/:id/history

返回该项目 cwd 的历史 cc session，按文件 mtime 倒序（最新在前）。

```
200 { "history": [ { "sessionId", "modifiedAt", "preview" }, ... ] }
404 :id 非配置项目
```

若该项目的历史目录不存在于磁盘，响应 MUST 是 `200 { "history": [] }`——
空历史不是 404。

### Requirement: POST /api/sessions

创建一个新 session。body MUST 是以下之一：

```json
{ "projectId": "<id>", "mode": "fresh", "cols"?, "rows"? }
```
```json
{ "projectId": "<id>", "mode": "resume", "sessionId": "<uuid>", "cols"?, "rows"? }
```

`cols` 与 `rows` 为可选正整数（1..1000）。

服务端 MUST：

1. 用 discriminated-union schema 校验 body；失败返回 `400 invalid_request`，
   附带 `issues` 数组。
2. 查 `projectId`；不命中返回 `404 not_found`。
3. 若 `mode == "resume"`，验证 `sessionId` 出现在 `listHistory(project.cwd)`
   中；不命中返回 `400 invalid_resume`。
4. spawn cc 进程；响应 `201` 并返回 session 行。

响应 body 形如：

```json
{
  "id": "<uuid>",
  "projectId": "<id>",
  "mode": "fresh|resume",
  "resumeSessionId": "<uuid>|null",
  "state": "starting|idle|busy|dead",
  "createdAt": <epoch-ms>,
  "deletedAt": null
}
```

#### Scenario: resume 指向未知 sessionId

- GIVEN `POST /api/sessions` body `{projectId, mode: "resume", sessionId: "x"}`
- AND   `"x"` 不在该项目的历史目录中
- WHEN  服务端处理
- THEN  状态 `400`，`error.code == "invalid_resume"`

### Requirement: GET /api/sessions

返回 manager 中**所有** session（含 dead、含 deleted）。

```json
{
  "sessions": [
    {
      "id", "projectId", "mode", "resumeSessionId",
      "state", "createdAt", "deletedAt"
    }, ...
  ]
}
```

客户端 MAY 按 `deletedAt === null` 过滤展示"未删除"。服务端 MUST NOT 过滤——
客户端需要看到 DELETE 的结果。

### Requirement: DELETE /api/sessions/:id

把一个 session 标记为已删除。幂等。

| 服务端状态                                       | 响应 |
|--------------------------------------------------|------|
| `:id` 命中现有 session 行                        | `204 No Content` |
| `:id` 命中已删除的 session 行                    | `204 No Content` |
| `:id` 从未存在过 **或已被 GC 回收**              | `404 not_found`  |

服务端 MUST 在某个 id 第一次 DELETE 时设置 `deletedAt = Date.now()`，
若 PTY 还活则触发 kill；后续列表响应中 session 行仍存在并带上 `deletedAt`，
直到被 GC 回收（详见 `sessions/spec.md`）。

同 id 的二次 DELETE MUST NOT 更新 `deletedAt`，MUST NOT 重复发 kill 信号。

被 GC 回收之后再 DELETE，行为与"从未存在过"一致——`404 not_found`。
GC 间隔由 `config.deletedSessionTtlMs` 控制，默认 10 分钟，覆盖单设备
移动场景下的合理重试窗口；超过该时长后 manager 视为客户端已放弃。

#### Scenario: 重复 DELETE 返回 204

- GIVEN 已经 DELETE 过一次的 session
- WHEN  用同 id 再次 DELETE
- THEN  状态 `204`
- AND   该 session 行的 `deletedAt` 不变

#### Scenario: DELETE 从未存在的 id

- GIVEN 一个 manager 中从未出现过的 id
- WHEN  发送 DELETE
- THEN  状态 `404`，`error.code == "not_found"`

#### Scenario: 已被 GC 回收的 id 等同于从未存在

- GIVEN 一个 session 在过去被 DELETE，且 deletedAt 距今超过 `deletedSessionTtlMs`
- WHEN  对该 id 发送 DELETE
- THEN  状态 `404`，`error.code == "not_found"`

### Requirement: Idempotency-Key for POST /api/sessions

`POST /api/sessions` MAY 携带 `Idempotency-Key` 请求头。当存在时，服务端
MUST 按下表处理：

| 服务端缓存状态                                | 响应 |
|----------------------------------------------|------|
| 无 key 命中                                   | 处理请求，结果入缓存（仅 2xx/4xx），响应附 `Idempotency-Stored: true` |
| key 命中且 body 哈希一致                      | 返回缓存的 status + body，响应附 `Idempotency-Replayed: true` |
| key 命中但 body 哈希不同                       | `409 idempotency_conflict` |
| key 命中但已过期                               | 视为未命中，按上表第一行处理 |

key 必须满足 `/^[A-Za-z0-9_-]{1,255}$/`；不满足返回
`400 invalid_idempotency_key`。

key 的命名空间 MUST 按用户 token 隔离——同一 `Idempotency-Key` 字符串
在不同用户 token 下视为不同条目。

缓存 TTL MUST 至少 1 小时（实现可允许配置，但本规范要求默认 3600 秒）。
5xx 响应 MUST NOT 入缓存。

#### Scenario: 同 key+body 重放

- GIVEN 第一次 `POST /api/sessions` 带 `Idempotency-Key: ABC` 创建成功（201）
- WHEN  以完全相同的 body 与 token 再次发送同样的请求
- THEN  状态 `201`
- AND   body 等于第一次的响应
- AND   响应头含 `Idempotency-Replayed: true`

#### Scenario: 同 key 不同 body 冲突

- GIVEN 已有 `Idempotency-Key: ABC` 对应 `projectId: demo`
- WHEN  以 `Idempotency-Key: ABC` 但 `projectId: other` 发送
- THEN  状态 `409`，`error.code == "idempotency_conflict"`

#### Scenario: 不同 token 命名空间隔离

- GIVEN token `T1` 用 key `ABC` 已创建一个 session
- WHEN  token `T2` 用同样的 key `ABC` 与 body 发送请求
- THEN  按"无 key 命中"处理，新建另一个 session
- AND   两次的 session id 不同

#### Scenario: 非法 key 字符

- GIVEN `Idempotency-Key: 包含中文`
- WHEN  发送请求
- THEN  状态 `400`，`error.code == "invalid_idempotency_key"`

### Requirement: POST /api/hook/:sessionId/:event

接收 cc 的 hook 回调；仅由内部 hook token 鉴权。

已知事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、
`Notification`、`Stop`、`SubagentStop`。

| 服务端状态                         | 响应 |
|-----------------------------------|------|
| event 不在已知集合内              | `400 invalid_event` |
| `:sessionId` 不在 manager 中      | `404 not_found` |
| event 合法且 session 存在         | `204 No Content` |

路由 MUST 按 `openspec/specs/hooks/spec.md` 驱动 session 状态机。
路由 MUST NOT 消费请求 body（hook 命令不发 body）。
