## ADDED Requirements

### Requirement: deleted session 的 GC

manager MUST 按 `config.deletedSessionTtlMs` 回收已软删除的 session。
回收意味着把该 session 行从 manager 内部 map 中物理移除——之后
`get(id)` 返回 `undefined`，`list()` / `listActive()` 不再包含。

回收触发时机 MUST 限于"活动入口"：

- `manager.spawn()` 进入。
- `manager.list()` 进入。
- `manager.listActive()` 进入。

回收条件：`session.deletedAt !== null` 且
`session.deletedAt + config.deletedSessionTtlMs < Date.now()`。

回收 MUST NOT 由独立后台 timer 触发。idle 状态下不跑 GC 是允许的——
没有访问意味着没有观察者关心 session 是否还在 map 里。

#### Scenario: 未到期不动

- GIVEN session 被 markDeleted，距今 5 分钟（< 10 分钟默认 TTL）
- WHEN  调用 `manager.list()`
- THEN  该 session 仍在返回数组中

#### Scenario: 过期被回收

- GIVEN session 被 markDeleted，距今 15 分钟（> 10 分钟默认 TTL）
- WHEN  调用 `manager.list()`
- THEN  该 session 不在返回数组中
- AND   `manager.get(sessionId)` 返回 `undefined`

#### Scenario: 活的 session 不受影响

- GIVEN session 处于 `idle`，`deletedAt === null`
- WHEN  时间流逝任意长度
- THEN  该 session 仍在 `listActive()` 返回中
- AND   `markDeleted` 之后才有资格被 GC 回收
