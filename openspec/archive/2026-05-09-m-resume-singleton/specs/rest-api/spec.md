## MODIFIED Requirements

### Requirement: POST /api/sessions

创建一个新 session **或** attach 到一个 resume 占用着的现有 web-session。
body MUST 是以下之一：

```json
{ "projectId": "<id>", "mode": "create", "cols"?, "rows"?, "webTheme"? }
```
```json
{ "projectId": "<id>", "mode": "resume", "sessionId": "<uuid>", "cols"?, "rows"?, "webTheme"? }
```

`cols` 与 `rows` 为可选正整数（1..1000）。`webTheme` 为可选枚举
`'dark' | 'light'`，缺失时 MUST NOT 注入主题相关 env。

`webTheme` 处理：服务端 MUST 在 spawn cc 子进程的 env 中按值注入 `COLORFGBG`：
`'dark'` → `COLORFGBG=15;0`、`'light'` → `COLORFGBG=0;15`。该 env 让 cc 在
`theme: 'auto'` 配置下选择匹配的内置配色。注：env 注入仅对新 spawn 生效，
对 cc `--resume` 的子进程是否 honor 由 cc 决定，不在本规范保证范围。

服务端 MUST：

1. 用 discriminated-union schema 校验 body；失败返回 `400 invalid_request`，
   附带 `issues` 数组。
2. 查 `projectId`；不命中返回 `404 not_found`。
3. 若 `mode == "resume"`，验证 `sessionId` 出现在 `listHistory(project.cwd)`
   中；不命中返回 `400 invalid_resume`。
4. 调用 `manager.spawn({...})` 并 match 返回值：
   - `{ kind: 'created', session }`：cc 进程已 spawn，响应 `201` + session 行。
   - `{ kind: 'attached', existingId }`：该 cc sessionId 已被某个未 dead
     的 web-session 占用，**不 spawn 新 cc**，响应 `200` + 现有 web-session
     的行（取 `manager.get(existingId)`）。详见
     `openspec/specs/sessions/spec.md` "resume 唯一性"。

attached 路径仅在 `body.mode === 'resume'` 时可能触发——`create` mode
永远走 created 路径。

响应 body 形如（200 与 201 schema 一致）：

```json
{
  "id": "<uuid>",
  "projectId": "<id>",
  "mode": "create|resume",
  "resumeSessionId": "<uuid>|null",
  "state": "starting|idle|busy|dead",
  "createdAt": <epoch-ms>,
  "deletedAt": null
}
```

> 注意：attached 路径返回的 `mode` 字段是 **现有 web-session 创建时的
> mode**——可能是 `'resume'`（同样 resume 进入），但理论上也可能是
> `'create'` 如果第一次创建走 create 然后某种实现路径让它持有 resumeTarget
> （当前实现下不会，因为只有 mode='resume' 才占用 lock，`create` 永远
> 不会触发 attached 命中）。

idempotency-key 处理（详见 "Idempotency-Key for POST /api/sessions"
Requirement）：服务端 MUST 把实际响应 status（200 或 201）作为缓存项的
status。重放时按缓存返回。

#### Scenario: resume 命中已活 web-session 返 200 attach

- GIVEN web-session `W1` 由前一次 `POST /api/sessions
  {projectId:'p', mode:'resume', sessionId:'X'}` 创建并 active
- WHEN  以同样 body 第二次 `POST /api/sessions`（**新** Idempotency-Key
  或不带 key）
- THEN  状态 `200`
- AND   响应 body `id` 等于 W1 的 web-session id（不是新生成的）
- AND   服务端 manager 中 cc 进程数不增（仍只有 W1 一个 cc）

#### Scenario: resume 已退出实例后再 resume 创建新 web-session

- GIVEN W1 之前 resume cc-X，但 W1.PTY 已 exit（state == 'dead'，
        `activeResumeTargets` 已释放 X）
- WHEN  `POST /api/sessions {projectId:'p', mode:'resume', sessionId:'X'}`
- THEN  状态 `201`（不是 200）
- AND   响应 body `id` 是新生成的 W2 id（不是 W1）

#### Scenario: resume 指向未知 sessionId

- GIVEN `POST /api/sessions` body `{projectId, mode: "resume", sessionId: "x"}`
- AND   `"x"` 不在该项目的历史目录中
- WHEN  服务端处理
- THEN  状态 `400`，`error.code == "invalid_resume"`
