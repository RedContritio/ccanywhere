## MODIFIED Requirements

### Requirement: POST /api/feedback

接收 web 客户端的用户反馈，落盘到 `~/.config/ccanywhere/feedback/<id>.json`
（mode `0600`），不入数据库。仅 cookie 鉴权可达。

```
请求: {
  "title": "<1..200 chars>",
  "body":  "<0..10000 chars, optional>",
  "ops":   [ { "ts": <int>, "kind": "<1..80 chars>", "payload"?: {...} }, ... ]  // optional, 最多 100 项
  "diag":  { ... }  // optional, 客户端自动收集的诊断信息（结构见下）
}
201 { "id": "<id>" }
400 invalid_request   body 校验失败（附 issues）
500 internal          落盘失败
```

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
  lastDataAt: number | null;   // 最近一次 PTY data 的 epoch-ms
  exitCode: number | null;     // PTY 退出码（state=='dead' 才有）
  deletedAt: number | null;
}
```

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

#### Scenario: diag.activeSessionId 命中时注入 serverSession

- GIVEN manager 中存在 sessionId `S` 处于 `idle`，scrollback `headSeq=1000`
- WHEN  `POST /api/feedback` body 含 `diag.activeSessionId == "S"`
- THEN  状态 `201`
- AND   落盘 JSON 含 `serverSession.state == "idle"` 且 `serverSession.headSeq == 1000`
- AND   落盘 JSON 含 `serverInfo.commitSha` 与 `serverInfo.uptimeMs`

#### Scenario: diag.activeSessionId 不命中时 serverSession 缺失

- GIVEN manager 中无 sessionId `X`
- WHEN  `POST /api/feedback` body 含 `diag.activeSessionId == "X"`
- THEN  状态 `201`（反馈仍落盘）
- AND   落盘 JSON 中 `serverSession` 字段不存在
- AND   落盘 JSON 仍含 `diag` 与 `serverInfo`
