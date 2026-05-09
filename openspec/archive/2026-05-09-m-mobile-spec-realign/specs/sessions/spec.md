## ADDED Requirements

### Requirement: PTY data 分片追踪

每个 session MUST 在 PTY `onData` 时 append 一条诊断记录到一个 session
生命周期内 append-only 的数组。该追踪与 scrollback / screenState 正交，
**仅用于反馈诊断**：让 feedback record 中的 `serverSession.recentDataChunks`
与客户端 `diag.term.screen` / `ops` trace 可三方对位还原 cc 输出时序
（识别 cc Ink TUI 同 chunk 重发 / scrollback 重画等上游行为）。

`Session` 接口 MUST 暴露：

```ts
interface Session {
  // ... existing fields ...
  readonly lastDataAt: number | null;     // 最近一次 onData 的 epoch-ms
  readonly exitCode: number | null;       // PTY 退出码（state == 'dead' 才有）
  readonly recentDataChunks: readonly PtyDataChunkRecord[];
}

interface PtyDataChunkRecord {
  readonly ts: number;       // epoch-ms
  readonly len: number;      // chunk 总字节数
  readonly head: string;     // chunk 前 32 字节 hex-escaped
                              // 控制字节展开为 \xNN
}
```

不变量：

- `recentDataChunks` MUST 是 append-only：每次 PTY `onData` 追加一条
  记录，session 生命周期内不裁剪、不重排。
- exit 时 MUST NOT 清空——dead session 在 GC 之前仍可被反馈引用。
- session GC 移除其 manager 行时 MUST 释放该数组（随 SessionImpl 实例）。
- `lastDataAt` 等于 `recentDataChunks` 末尾 record 的 `ts`（若数组非空）。
- `exitCode` MUST 在 `pty.onExit` 时设置；`null` 表示 PTY 未退出。

`head` 编码：原始字节中 ASCII 可见区直出，控制字节（`\x00`-`\x1f` /
`\x7f`）转 `\xNN`。32 字节上限是为了让单条 record 在 JSON 序列化后
~100 B（chunk 末段不含），全长 chunk 仍可由 `len` 比对客户端测量值。

内存：cc idle 状态约 10 chunks/s × ~100 B = ~5 MB/小时；`busy` 高峰
约翻倍。dogfood 单 session 寿命典型 < 24h，不需要裁剪。后续若长寿
session 触及内存压力，可在写入处按 byte cap 裁剪（保留尾部 N 条），
**不影响契约语义**——消费者按"append-only 不重排"读取即可。

#### Scenario: 每条 PTY chunk 落一条 record

- GIVEN session 已 spawn
- WHEN  PTY 发出 `"hello\n"`（6 字节）
- THEN  `recentDataChunks` 末尾新增一条 `{ ts, len: 6, head: "hello\\n" }`
- AND   `lastDataAt === ts`

#### Scenario: 控制字节在 head 中 hex-escaped

- GIVEN PTY 发出 `"\x1b[2J"`（4 字节，alt-screen 清屏）
- WHEN  追加进 `recentDataChunks`
- THEN  `head === "\\x1b[2J"`（而非原始 ESC 字符）
- AND   `len === 4`

#### Scenario: dead session 仍保留历史 chunks

- GIVEN session 已 exit，`exitCode = 0`
- WHEN  在 GC 之前读 `recentDataChunks`
- THEN  仍返回 spawn 以来的全部 record
- AND   session 行被 GC 后 `manager.get(id)` 返回 `undefined`，引用一并释放

#### Scenario: chunk 超 32 字节仅记录 head

- GIVEN PTY 发出一个 1000 字节 chunk
- WHEN  追加进 `recentDataChunks`
- THEN  record 的 `len === 1000`
- AND   `head` 长度 ≤ 32 字节（hex-escaped 后字符数可能略大于 32）
