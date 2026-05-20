# Hooks (opt-in)

ccanywhere 默认 **不** 自动给 cc 注入 hook 配置——一旦注入会屏蔽 user 的
`~/.claude/`，让每个 web-spawned cc 都要重新登录（M-hook-opt-in 修复了这个
设计错误）。

代价：默认部署下，session 状态徽标永远是 `idle`（直到 PTY 退出变 dead），
**无法显示 cc 正在执行 turn 的 `busy` 状态**，浏览器桌面通知（M7）也不会
触发。

如果你想要这些功能，把 hook 段**手动**贴到 `~/.claude/settings.json`。下面
是步骤。

## 1. 拿到 internalHookToken

ccanywhere 启动时会在日志里打出：

```
"msg": "ccanywhere listening (paste internalHookToken into ~/.claude/settings.json hooks)"
"internalHookToken": "<32-byte hex>"
```

每次重启 token 会变。这个 token 仅服务于 `/api/hook/*` 路由——不能用来登录
web，泄漏风险有限，但仍建议从 `server.log` 拷出后立即关闭文件。

```bash
grep internalHookToken ~/.config/ccanywhere/server.log | tail -1
```

## 2. 把 hook 段贴进 `~/.claude/settings.json`

完整示例（替换 `INTERNAL_HOOK_TOKEN` 与端口）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -fsS -m 2 -X POST -H \"Authorization: Bearer INTERNAL_HOOK_TOKEN\" \"http://127.0.0.1:8081/api/hook/$CLAUDE_SESSION_ID/SessionStart\" >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "curl -fsS -m 2 -X POST -H \"Authorization: Bearer INTERNAL_HOOK_TOKEN\" \"http://127.0.0.1:8081/api/hook/$CLAUDE_SESSION_ID/UserPromptSubmit\" 2>/dev/null || true" }] }],
    "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "curl -fsS -m 2 -X POST -H \"Authorization: Bearer INTERNAL_HOOK_TOKEN\" \"http://127.0.0.1:8081/api/hook/$CLAUDE_SESSION_ID/PreToolUse\" >/dev/null 2>&1 || true" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "curl -fsS -m 2 -X POST -H \"Authorization: Bearer INTERNAL_HOOK_TOKEN\" \"http://127.0.0.1:8081/api/hook/$CLAUDE_SESSION_ID/Stop\" >/dev/null 2>&1 || true" }] }],
    "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "curl -fsS -m 2 -X POST -H \"Authorization: Bearer INTERNAL_HOOK_TOKEN\" \"http://127.0.0.1:8081/api/hook/$CLAUDE_SESSION_ID/SubagentStop\" >/dev/null 2>&1 || true" }] }]
  }
}
```

`$CLAUDE_SESSION_ID` 是 cc 在 hook 命令执行时设置的环境变量（cc 自己的
session id，不是 ccanywhere 的）。**注意**：当前 ccanywhere hook 路由
预期收到 ccanywhere 的 sessionId，而不是 cc 的——后续 milestone 可能会调整
这一点，目前的 opt-in 流程是 best-effort，事件能到、状态机会动，但 session
归属可能不精确（busy/idle 切到了同一 cc 进程对应的所有 ccanywhere session）。

## 3. 命令解构

每条 hook 命令的结构：

```bash
curl -fsS -m 2 \
  -X POST \
  -H "Authorization: Bearer INTERNAL_HOOK_TOKEN" \
  "http://127.0.0.1:8081/api/hook/<sessionId>/<event>" \
  >/dev/null 2>&1 || true
```

| 选项 | 用途 |
|------|------|
| `-fsS` | 失败时仍打印错误（`-S`），但不显示进度（`-s`）；HTTP 错误返回非零（`-f`） |
| `-m 2` | 最长挂 2 秒，避免拖慢 cc 主流程 |
| `>/dev/null 2>&1` | 静默——cc 的 hook 阶段是 fire-and-forget |
| `\|\| true` | 即使 curl 因网络问题失败也让 cc 继续 |

** 后**：所有事件统一 fire-and-forget，stdout 与 stderr
都可丢弃。reframe 之前 UserPromptSubmit 命令用 `2>/dev/null`（保留 stdout
让 cc 读 quota block JSON）；reframe 后 quota enforcement 已搬到 ws input
gate，UserPromptSubmit hook 不再返 block JSON。两种写法都兼容（旧粘贴
不破），但新部署推荐统一 `>/dev/null 2>&1`。

**hook 不再是 quota 必需配置**：UserPromptSubmit hook 完全漏配也不影响
quota 工作（input gate 直接拦超额；jsonl fs.watch 自动刷新 used）。
hook 仍然是 session state machine（busy↔idle 标识）的唯一信号源。

## 4. 验证 hook 工作

1. 启动 ccanywhere（确保 internalHookToken 是 settings.json 里那个）
2. web 上创建一个 session
3. 在 cc 里发一个 prompt（按回车）
4. 观察 web 端 session 列表里的状态徽标：应该立刻变 `busy`（PreToolUse 或
   UserPromptSubmit 触发），cc 输出完后变回 `idle`（Stop 触发）
5. ccanywhere log 里应能看到 `"msg":"hook applied"` 之类条目

如果状态不动：

- `curl http://127.0.0.1:8081/healthz` 看 ccanywhere 是否在跑
- 直接 `curl -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:8081/api/hook/test/PreToolUse`
  应该返回 404（`session not found`）—— 说明 hook receiver 在工作
- 如果返回 401，说明 token 不对，重新从 server.log 取

## 5. 安全注意

- `internalHookToken` 仅本机 cc 子进程使用——不要从外部网络访问 `/api/hook/*`
- 把 settings.json 权限收紧：`chmod 600 ~/.claude/settings.json`
- ccanywhere 重启后 token 会变；同步更新 settings.json，否则 hook 全 401
