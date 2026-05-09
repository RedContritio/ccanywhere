# Retrofit batch — 2026-05-09

## Why

从 `8a4fad7 docs(openspec): merge & archive m5b-weak-network` 之后到
`ad80e4d polish: WS seq+ack incremental + xterm render lockdown + feedback
channel + auto-error-report` 之前，有 7 项 commit 直接 ship 了契约层改动，
没走 `openspec/changes/<name>/` 流程。这违反了 `openspec/AGENTS.md` 第 3 条
（"跨契约的改动必须先提案"）。

本目录是事后追认（retrofit）的审计记录。每条被追认的变更：(a) 有现成代码
作真理，(b) 已有测试覆盖，(c) 不再值得反向写完整 propose/design/tasks。
因此 retrofit 直接 patch `openspec/specs/<capability>/spec.md`，不在
`changes/` 立目录、不写 deltas——审计痕迹就是这个 RETROFIT.md。

后续新工作（task #26 M-feedback-diag-enrich 起）MUST 按完整流程走。

## Retrofit 清单

| Commit | 任务 | 影响 capability | 主要 spec patch |
|---|---|---|---|
| `8249e62` | #13 M-https-switch | （部署运维） | 不进 specs/（部署细节） |
| 多 commit | #14 fix:scroll-clip | web-frontend | 不进 specs/（CSS 细节） |
| `5661e9b` | #15 M-rename-web | web-frontend | 不进 specs/（UI brand 文案） |
| `0de33a6` | #16 M-cwd-adhoc | rest-api | 已在 a 同步：GET /api/projects 改 dynamic scan + hidden 列表恢复 |
| `e467f79` | #18 M-device-pair-webauthn | auth、rest-api | 已在 e467f79 同步进 specs/auth（cookie + WebAuthn pair/login）；本次再确认 |
| `ad80e4d`(部分) | #22 M-renderer-perf | web-frontend、ws-protocol | renderer 默认 dom + chunkedWrite + ws snapshot 改用 screenState |
| `ad80e4d`(部分) | #23 M-ws-seq-ack | ws-protocol、sessions | snapshot.upToSeq + output.seq + ?lastSeq=N + scrollback.headSeq/tailSeq/since + screenState |
| `d24c19e` | drawer/dialog/cc theme env | rest-api、web-frontend | POST /api/sessions body 加 webTheme + 反馈 dialog/auto-error-report |
| `ad80e4d`(部分) | feedback channel | rest-api、web-frontend | POST /api/feedback + ops-log + ErrorBoundary auto-submit |

## 实际 patch 范围

### `openspec/specs/ws-protocol/spec.md`

- "连接路径与鉴权"：`?token=` 改 cookie；新增 `?lastSeq=N` query 参数语义。
- "服务端帧格式"：`snapshot` 加 `upToSeq`、`output` 加 `seq`，cumulative
  byte counter 语义说明；`snapshot.data` 改为 minimal-ANSI 来自 screenState。
- "连接初始化序列"：从"立即发 snapshot+status"改为"等首个 resize → 200ms
  延迟 → 按 lastSeq 协商 incremental delta vs fallback snapshot"，含 1.5s
  兜底；新增 4 个 scenarios。
- "重连语义"：改写为"按 lastSeq 协商"，引用初始化序列。
- 缺 cookie scenario 替换缺 token scenario。

### `openspec/specs/sessions/spec.md`

- "scrollback ring buffer"：加 `headSeq`/`tailSeq` cumulative byte counter +
  `since(seq)` API + `clear()` 不重置 `headSeq` 的语义；新增 3 个 scenarios。
- 新增 Requirement "server-side 屏幕镜像（screenState）"：用
  `@xterm/headless` + `SerializeAddon`，PTY data 同步 feed、resize 同步、
  exit dispose；snapshot 输出 minimal-ANSI；含 2 个 scenarios。

### `openspec/specs/rest-api/spec.md`

- "POST /api/sessions"：body 加 `webTheme: 'dark' | 'light'` 可选；服务端
  注入 `COLORFGBG=15;0`/`0;15`。
- 新增 Requirement "POST /api/feedback"：title 必填、body 可选、ops 数组可选；
  落盘 `~/.config/ccanywhere/feedback/<id>.json` mode 0600；含 2 个 scenarios。

### `openspec/specs/web-frontend/spec.md`

- "登录与持久化" → "设备配对与登录"：完全重写，去掉 token 输入，引用
  WebAuthn pair/login 流程；强调 cookie 自动随请求带、不能写 localStorage。
- "终端视图"：去掉 `?token=`；加 open 后立即 fit+resize；snapshot 帧用
  `term.reset() + chunkedWrite`、output 帧 `chunkedWrite` 不 reset；
  `chunkedWrite` 4KiB/RAF 分片语义；online + visibilitychange 触发 force
  reconnect；含 lastSeq incremental 重连 scenario。
- 新增 "终端 renderer 选择策略"：默认 dom；URL `?renderer=` 不持久化；
  `term.dispose()` 不手动 dispose addon；含 2 个 scenarios。
- 新增 "新建 session 携带当前主题"：POST body 含 `webTheme`；env 注入仅
  作用新 spawn；含 1 个 scenario。
- 新增 "WebSocket 重连协议（lastSeq）"：客户端 lastSeq 维护 + URL 拼接。
- 新增 "用户反馈渠道"：手动 dialog + ErrorBoundary auto-submit；ops-log
  ring buffer + recordOp 触发点；含 1 个 scenario。

### 未追认（刻意保留）

- brand 改为 "CC anywhere"：UI 文案，不入契约层。
- mobile drawer 重构：UI 实现细节。
- touch handling preventDefault 阈值：实现策略，task #24 仍在 pending。
- M-https-switch：部署运维，不属任何 capability。
- LaunchAgent LOG_LEVEL=debug：本地开发配置。
