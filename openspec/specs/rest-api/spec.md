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

- GIVEN `GET /api/nope` 带合法 cookie
- WHEN  服务端处理
- THEN  状态 `404`
- AND   body 等于 `{"error": {"code": "not_found", "message": "route not found"}}`

### Requirement: GET /api/projects

返回 `projectsRoot` 下当前可见的项目（每次请求实时扫盘 + 过滤隐藏列表）。

```
200 { "projects": [ { "id", "name", "cwd" }, ... ] }
```

响应 MUST 按 `id` 字典序列出**所有**未被隐藏的子目录。系统是单用户的，不做
用户级过滤。`id` MUST 等于子目录 basename，`cwd` MUST 等于该 basename 在
`projectsRoot` 下的完整绝对路径。

### Requirement: POST /api/projects

在 `projectsRoot` 下创建一个新的项目子目录。

```
请求: { "name": "<basename>" }
201 { "id": "<basename>", "name": "<basename>", "cwd": "<projectsRoot>/<basename>" }
400 invalid_request   非空、≤255 字符、不含 `/` 和 0x00-0x1f、非 `.`/`..`
403 forbidden         projectsRoot 不可写（启动时 `writable=false`）
409 already_exists    同名目录已存在
```

若该 name 之前被 hide 过，create 成功后 MUST 自动从 hidden 列表移除（恢复
可见）。

### Requirement: DELETE /api/projects/:id

将项目从可见列表中移除（**软删除**：磁盘目录保留）。

```
204             成功（首次或重复 DELETE 同 id 都返回 204，幂等）
404 not_found   :id 不在当前可见列表
```

恢复一个被 hide 的项目：手动编辑 `~/.config/ccanywhere/projects-state.json`
删掉 `hidden` 数组中的 id；或重新 POST 创建（若磁盘目录已被删，会重建）。

### Requirement: GET /api/projects/:id/history

返回该项目 cwd 的历史 cc session，按文件 mtime 倒序（最新在前）。

```
200 { "history": [ { "sessionId", "modifiedAt", "preview" }, ... ] }
404 :id 非配置项目
```

若该项目的历史目录不存在于磁盘，响应 MUST 是 `200 { "history": [] }`——
空历史不是 404。

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

idempotency-key 处理（详见 "Idempotency-Key for POST /api/sessions"
Requirement）：服务端 MUST 把实际响应 status（200 或 201）作为缓存项的
status；后续重放时按缓存返回原 status 与 body。

#### Scenario: resume 指向未知 sessionId

- GIVEN `POST /api/sessions` body `{projectId, mode: "resume", sessionId: "x"}`
- AND   `"x"` 不在该项目的历史目录中
- WHEN  服务端处理
- THEN  状态 `400`，`error.code == "invalid_resume"`

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

key 的命名空间 MUST 按 web device 隔离——同一 `Idempotency-Key` 字符串
在不同 device 的 cookie 下视为不同条目。

缓存 TTL MUST 至少 1 小时（实现可允许配置，但本规范要求默认 3600 秒）。
5xx 响应 MUST NOT 入缓存。

#### Scenario: 同 key+body 重放

- GIVEN 第一次 `POST /api/sessions` 带 `Idempotency-Key: ABC` 创建成功（201）
- WHEN  以完全相同的 body 与 cookie 再次发送同样的请求
- THEN  状态 `201`
- AND   body 等于第一次的响应
- AND   响应头含 `Idempotency-Replayed: true`

#### Scenario: 同 key 不同 body 冲突

- GIVEN 已有 `Idempotency-Key: ABC` 对应 `projectId: demo`
- WHEN  以 `Idempotency-Key: ABC` 但 `projectId: other` 发送
- THEN  状态 `409`，`error.code == "idempotency_conflict"`

#### Scenario: 不同 device 命名空间隔离

- GIVEN device `D1` 用 key `ABC` 已创建一个 session
- WHEN  device `D2` 用同样的 key `ABC` 与 body 发送请求
- THEN  按"无 key 命中"处理，新建另一个 session
- AND   两次的 session id 不同

#### Scenario: 非法 key 字符

- GIVEN `Idempotency-Key: 包含中文`
- WHEN  发送请求
- THEN  状态 `400`，`error.code == "invalid_idempotency_key"`

### Requirement: 静态资源服务（SPA 入口）

服务端 MUST 在 `web/dist/` 存在时注册 `@fastify/static`，把该目录挂在
HTTP root（`/`）。

未匹配任何 `/api/*` 与 `/ws/*` 路由的 GET 请求 MUST 返回 `web/dist/index.html`，
让 client-side 路由（react-router-dom）接管。其它方法的未匹配请求仍 404。

`web/dist/` 不存在时（例如纯后端开发或镜像未包含前端构建产物），服务端 MUST
仍能正常启动，仅 `/`、SPA 路径返回 404 with 标准 envelope。

SPA 静态资源（含 SPA fallback `index.html`）与 `/healthz` MUST 是公开的，
不强制鉴权——cookie 鉴权仅约束 `/api/*` 与 `/ws/*` 路由。

#### Scenario: 构建产物存在时 GET / 返回 index.html

- GIVEN `web/dist/index.html` 存在
- WHEN  `GET /`（不带 cookie）
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
- WHEN  `GET /api/projects` 带合法 cookie
- THEN  状态 `200`，响应 body 是 JSON（不是 index.html）

### Requirement: 内部 RPC 路由 `/api/internal/*`

mac CLI 子命令通过 cliToken 调以下端点：

- `GET /api/internal/devices` — 列出所有 device（含 revoked）
- `DELETE /api/internal/devices/:id` — 撤销 device
- `GET /api/internal/pending` — 列出 awaiting-approval 的 pending pair
- `POST /api/internal/pending/:id/approve` — approve 一个 pending
- `DELETE /api/internal/pending/:id` — reject

cliToken 在 `~/.config/ccanywhere/cli-token`（mode 0600）；首次 `ccanywhere
serve` 启动时自动生成，后续重启沿用。

### Requirement: POST /api/feedback

接收 web 客户端的用户反馈，落盘到 `~/.config/ccanywhere/feedback/<id>.json`
（mode `0600`），不入数据库。仅 cookie 鉴权可达。

```
请求: {
  "title": "<1..200 chars>",
  "body":  "<0..10000 chars, optional>",
  "ops":   [ { "ts": <int>, "kind": "<1..80 chars>", "payload"?: {...} }, ... ]  // optional
  "diag":  { ... }  // optional, 客户端自动收集的诊断信息（结构见下）
}
201 { "id": "<id>" }
400 invalid_request   body 校验失败（附 issues）
500 internal          落盘失败
```

`ops` 数组上限 MUST 由客户端 `MAX_OPS` 决定（见
`openspec/specs/web-frontend/spec.md` "用户反馈渠道"中的 `N` 推导，
当前基线 ~6500）。服务端 MUST NOT 强约束等于客户端值——客户端调整
保留窗口或峰值密度时，服务端不应同步升级才不阻塞反馈。服务端
MUST 设一个 runaway guard（基线 `20000`，比客户端常态值高一个数量级），
仅防御明显 abuse（恶意客户端绕推导直接灌大数组）。超 guard 返
`400 invalid_request`。

`id` MUST 形如 `<ISO-时间戳>-<4 字节 hex>`（时间戳里的 `:` 与 `.` 替换为 `-`，
让 `ls` 输出按时间字典序）。

服务端落盘的 record MUST 包含请求 body 的 `title`/`body`/`ops`/`diag`，并
MUST 附加：

| 字段 | 来源 |
|---|---|
| `id` | 服务端生成 |
| `submittedAt` | epoch-ms |
| `deviceId` | 解析自 cookie 的 device，未鉴权时为 `null` |
| `deviceLabel` | 同上 |
| `userAgent` | 请求头 `User-Agent`，缺失为 `null` |
| `remoteAddr` | 客户端 IP |
| `serverInfo` | `{ commitSha, uptimeMs }` |
| `serverSession` | 仅当 `diag.activeSessionId` 命中 manager 时存在 |

`serverSession` 字段（命中时）：

```ts
{
  state: 'starting' | 'idle' | 'busy' | 'dead';
  headSeq: number;
  tailSeq: number;
  scrollbackBytes: number;
  lastDataAt: number | null;            // 最近一次 PTY data 的 epoch-ms
  exitCode: number | null;              // PTY 退出码（state=='dead' 才有）
  deletedAt: number | null;
  recentDataChunks: PtyDataChunkRecord[]; // session 生命周期内 append-only
                                            // 全量 PTY chunk 时序，定义见
                                            // openspec/specs/sessions/spec.md
                                            // "PTY data 分片追踪"
}
```

`recentDataChunks` 注入是 server side 唯一的反馈数据源——客户端无法
观察到这级时序。该字段尺寸随 session 寿命增长（参考 sessions spec
中的内存估算），有需要时服务端可在反馈落盘前按 byte cap 截断尾部 N 条，
**不破坏 schema**。

`diag.activeSessionId` 不命中（id 不存在 / 已 GC）时 `serverSession` MUST
缺失（不写 null 占位）；反馈 record 仍正常落盘，反馈不因 server inject
失败而拒收。

`diag` 字段（请求 body 提供时透传到 record）：

```ts
{
  activeSessionId?: string;
  viewport?: {
    cols?: number; rows?: number;        // xterm 维度
    windowW: number; windowH: number;     // window.innerWidth / Height
    devicePixelRatio: number;
    orientation?: string;
  };
  net?: {
    online: boolean;
    effectiveType?: string;
    downlink?: number;
  };
  app?: {
    activeSessionId?: string;
    sessionIds?: string[];
    theme?: string;                       // 'auto' | 'light' | 'dark'
    effectiveTheme?: string;              // 'light' | 'dark'
  };
  ws?: {
    readyState?: number;
    lastSeq?: number;
    retryIdx?: number;
    lastFrameTs?: number;
    lastFrameType?: string;
    sinceLastFrameMs?: number;
  };
  term?: {
    rendererKind?: string;                // 'dom' | 'canvas' | 'webgl'
    lastWriteTs?: number;
    screen?: string[];                    // 行级纯文本，可见区 + 上方 ~20 行
  };
  memory?: {
    jsHeapSizeLimit?: number;
    totalJSHeapSize?: number;
    usedJSHeapSize?: number;
  };
}
```

服务端 schema 校验 MUST 仅强校验 `diag.activeSessionId` 是 string（用于
manager 查询）。其它字段 MUST 用宽松 schema（passthrough），允许客户端
后续扩字段不破坏校验——诊断结构会随实际定位需求迭代，强 schema 反而
让 server 与 client 升级时序耦合。

服务端 MUST 在 `~/.config/ccanywhere/feedback/` 目录不存在时递归创建。

#### Scenario: 缺 title 返 400

- GIVEN body `{ "body": "x" }`（无 title）
- WHEN  发送 `POST /api/feedback`
- THEN  状态 `400`，`error.code == "invalid_request"`，`error.issues` 含 title 字段错误

#### Scenario: 落盘后返回 id

- GIVEN body `{ "title": "渲染崩溃" }`
- WHEN  发送 `POST /api/feedback`
- THEN  状态 `201`，body `{ "id": "<id>" }`
- AND   `~/.config/ccanywhere/feedback/<id>.json` 存在且 mode 为 `0600`

#### Scenario: diag.activeSessionId 命中时注入 serverSession + recentDataChunks

- GIVEN manager 中存在 sessionId `S` 处于 `idle`，scrollback `headSeq=1000`，
        且 `S.recentDataChunks` 含 N 条 PTY chunk record
- WHEN  `POST /api/feedback` body 含 `diag.activeSessionId == "S"`
- THEN  状态 `201`
- AND   落盘 JSON 含 `serverSession.state == "idle"` 且 `serverSession.headSeq == 1000`
- AND   落盘 JSON 含 `serverSession.recentDataChunks` 数组长度 == N
- AND   落盘 JSON 含 `serverInfo.commitSha` 与 `serverInfo.uptimeMs`

#### Scenario: diag.activeSessionId 不命中时 serverSession 缺失

- GIVEN manager 中无 sessionId `X`
- WHEN  `POST /api/feedback` body 含 `diag.activeSessionId == "X"`
- THEN  状态 `201`（反馈仍落盘）
- AND   落盘 JSON 中 `serverSession` 字段不存在（含 `recentDataChunks` 也不存在）
- AND   落盘 JSON 仍含 `diag` 与 `serverInfo`

#### Scenario: ops 超 runaway guard 拒收

- GIVEN body `{ "title": "x", "ops": <长度 30000 的合法数组> }`
- WHEN  发送 `POST /api/feedback`
- THEN  状态 `400`，`error.code == "invalid_request"`
- AND   `error.issues` 指出 ops 长度违反约束

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
