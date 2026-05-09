# Proposal: M-ws-init-state-gating — initial-state 之前 broadcast 必须缓存

## Intent

`openspec/specs/ws-protocol/spec.md` "连接初始化序列" 要求服务端在收到首个
`resize` 后等约 200 ms，再按 `?lastSeq=N` 发 `snapshot` (或 `output` 增量)
+ `status`，让客户端拿到一致的初始状态再开始 `term.write`。客户端
spec "终端视图" 进一步要求"收到 snapshot 后 reset xterm buffer"。

实施中违约：`src/ws/server.ts:111-128` `attach(session)` 内 `session.on('data',
...)` 立即 broadcast 给 `bundle.clients`；`L163-164` `bundle.clients.add(sock)`
紧跟 `attach`，再到 `L209` / `L249` 才 `sendInitialState`。这之间任何 PTY
data 直接 `sendFrame(sock, output)`，client 在 `snapshot` 之前先收 `output`，
随后 snapshot 的 `term.reset()` 清掉刚写入的内容，造成"短暂闪现 → 全屏
重置"或更糟（snapshot data 是 minimal-ANSI 全状态，与之前 output 交错可能
导致 SGR / cursor 错位）。

`status` 帧路径 `L131-136` 同病：connect 期间 session.state 切换 (`starting
→ idle`) 直接发 `status`，可能先于 `snapshot` 到达。

`error` / `pong` / heartbeat ping 都是 `sendFrame(sock, ...)` 不进 broadcast
路径，不在违约面。

现有 test `'delivers snapshot then status on connect'` 用 `waitFor('snapshot')`
不验证"snapshot 是第一帧"——若先来 output 帧 helper 也会 buffer 不报错，
所以 bug 没被 CI 捕获。

## Approach

### per-socket pending queue

`SessionBundle` 加 `pendingClients: Map<WebSocket, ServerFrame[]>`：
sock connect 时同时加入 `clients` Set 与 `pendingClients` Map（空 queue）。

新增 `deliver(bundle, c, frame)` 包装：

```
function deliver(bundle, c, frame):
  queue = bundle.pendingClients.get(c)
  if queue !== undefined: queue.push(frame)   # gating
  else: sendFrame(c, frame)                    # active
```

把 data 与 status 两个 listener 内的 `sendFrame(c, frame)` 改为 `deliver(c, frame)`。
其它 sendFrame（error / pong / sendInitialState 自身发的 snapshot/output/status）
保持直接 send——这些帧本身就是 init-state 一部分或对端独立请求的响应，
不应被 gate。

### sendInitialState 末尾 drain queue

```
sendInitialState():
  ... 现有逻辑发 snapshot 或 incremental output + status ...
  let snapshotUpToSeq = headSeq  # 不论哪条路径，sendInitialState 发完后
                                  # client 已"看到"到 headSeq 为止的全部字节
  let queue = bundle.pendingClients.get(sock)
  bundle.pendingClients.delete(sock)  # 关键：先 delete 再遍历
                                       # 避免 send 同步 throw 时残留
  if queue: for frame in queue:
    if frame.type === 'output' && frame.seq <= snapshotUpToSeq: continue  # snapshot 已覆盖
    if frame.type === 'status': continue  # sendInitialState 末尾已发当前 state
    sendFrame(sock, frame)
```

### snapshotUpToSeq 在所有路径下都等于发送时的 scrollback.headSeq

- 首连 (`lastSeq == 0`) 或 fallback：发 `snapshot { upToSeq: headSeq, ... }` →
  `snapshotUpToSeq = headSeq`。
- incremental (`lastSeq > 0`，delta 非 null)：发 `output { seq: headSeq,
  data: delta }`，delta 覆盖 `(lastSeq, headSeq]` → 加上客户端已有的
  `(0, lastSeq]`，等价 `(0, headSeq]` 全覆盖 → `snapshotUpToSeq = headSeq`。
- nothing-missed (`lastSeq == headSeq`)：不发任何 data 帧，但 client 已经
  在 lastSeq 拥有全部历史 → `snapshotUpToSeq = headSeq`。

### 为什么 buffered output 一定 drop（不会有 seq > snapshotUpToSeq）

Node 单线程 + `Scrollback.append(data)` 在 PTY `onData` 内同步执行（先 append
再 emit `'data'`），`flush` 拿到的 `headSeq` 是包含本 chunk 的累积值。
sendInitialState 由 `setTimeout` 调度，跑时序号 ≥ 任何已 buffered frame 的
seq。所以 `frame.seq <= snapshotUpToSeq` 在所有 buffered output 上恒真，
drain 时全部 drop——pending queue 实际上是"防止越早 send"，drain 是"幂等
弃旧"。

### sock close 时清理

`sock.on('close', ...)` 加 `bundle.pendingClients.delete(sock)`，避免 sock
在 sendInitialState 之前就关闭时 map 残留。

## Scope

- 改 `src/ws/server.ts`：加 `pendingClients` 字段、`deliver()` 包装、status
  listener 路径走 deliver、sendInitialState 末尾 drain、close handler 清理。
- 改 `src/ws/server.test.ts`：加 test 验证 connect 后第一帧必是 snapshot，
  期间 PTY 持续输出不会让 output 抢先；多 client 场景下后到的 client 也
  按规则 gate（不影响先到 client）。
- spec delta：ws-protocol/spec.md "连接初始化序列" 加 ADDED Requirement
  "initial-state gating"，含 4 个 scenario。

## Out of scope

- 不改 ClientFrame schema、不改 lastSeq 协商规则（不变）。
- 不改 1.5s fallback timer（不变）。
- 不改 status 帧的语义（只在传输时 gate）。
- 不改 pong / error / heartbeat 任意路径。

## 形式化保证

| 性质 | 保证机制 |
|---|---|
| client 第一个 server 帧必是 snapshot/output/status 三元组之一（init-state 套件） | 所有 broadcast 走 deliver；deliver 在 pending 期间 push queue |
| snapshot 之后的 output 不重复（不重发已被 snapshot 覆盖的字节） | drain 规则 `frame.seq <= snapshotUpToSeq → drop`；node 单线程证明所有 buffered output 必命中此条件 |
| pre-snapshot 的 status 不污染 client 状态 | drain 阶段 status 全 drop；sendInitialState 末尾发当下 session.state 一次 |
| sock 在 init-state 之前就关闭不漏 map entry | sock.on('close') 内 `pendingClients.delete(sock)` |
| 多 client 场景独立 gate | pending queue 是 per-socket Map；先到 client 已 active 不受新 client 影响 |
