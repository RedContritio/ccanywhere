## ADDED Requirements

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

## MODIFIED Requirements

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

(Previously: 表的第三行只有"`:id` 从未存在过 → 404"，不含"或已被 GC 回收"。
Requirement 描述未提及 GC 时机。)

#### Scenario: 已被 GC 回收的 id 等同于从未存在

- GIVEN 一个 session 在过去被 DELETE，且 deletedAt 距今超过 `deletedSessionTtlMs`
- WHEN  对该 id 发送 DELETE
- THEN  状态 `404`，`error.code == "not_found"`
