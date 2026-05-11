# Proposal: m-feedback-cli — `ccanywhere feedback` 子命令族（list/show/seen-dedup）

## Intent

mac CLI 加 `feedback` 子命令族，让 owner 在终端审阅 web 端用户反馈不用
手动 `cat ~/.config/ccanywhere/feedback/<id>.json` parse 长 JSON。两笔
commit 顺序 ship：

1. `f34d195` — list / show （summary + key diag + ops 直方图）
2. `bfdc40b` — seen-set dedup（list 默认仅未读 / show 自动标记 /
   mark-seen / mark-all-seen / forget），把"避免重复读"从软约定升级
   工具层 invariant

## 决策摘要

| # | 决策 | 拍 |
|---|---|---|
| 入口 | 纯本地读 `<configDir>/feedback/*.json`，不走 internal RPC | service down 也能 review |
| 状态机 | seen-set（unread/seen 两态） | 默认 list 自动 dedup；show 自动 mark；forget 反向 |
| list 默认字段 | time-ago / device / id-prefix / title 4 字段 | `--verbose` 加 ops 数 / renderer / fontSize / cols×rows / dpr |
| show 默认输出 | summary（含 diag 关键 + ops 直方图 top 10）| `--full` 切 pretty JSON |
| 搜索 | id-prefix 模糊匹配 | filter / grep 暂不做 |
| prune | 不做（42 笔 backlog 可接受） | 长期再加 |
| seen-set 持久化 | `<configDir>/feedback-seen.json` (0o600, sort 后 JSON) | 跨 session 持久；可 git-track dotfiles |

## 数据模型

`<configDir>/feedback-seen.json`：

```json
{ "seen": ["2026-05-09T...-abc111", "2026-05-09T...-bbb222", ...] }
```

非破坏性：missing / malformed 文件容忍，fallback 空集（cost-vs-crash
权衡）。

## CLI 表面

```
ccanywhere feedback list [--verbose] [--json] [--all]
                                   list submitted feedback (newest first;
                                   default skips seen)
ccanywhere feedback show <id-prefix> [--full] [--no-mark]
                                   show one feedback; --no-mark skips
                                   marking it seen
ccanywhere feedback mark-seen <id-prefix>
ccanywhere feedback mark-all-seen
ccanywhere feedback forget <id-prefix>
                                   remove from seen set (re-unread)
```

## 形式化保证

| 性质 | 机制 |
|---|---|
| 默认 list 不重复 | seen-set 文件 + `unreadOnly: true` 默认过滤 |
| show 自动标记 | runFeedbackShow `markSeen: true` 默认 |
| 偶发"peek 但不污染状态" | `show --no-mark` |
| 状态文件腐烂不致 crash | load 容忍 missing / malformed → 空集 |
| seen-set 跨 session 持久 | 写 `<configDir>/feedback-seen.json` 不在 conversation 内 |

## 落地位置

- `src/cli/feedback.ts` — list / show 主路径（271 LOC）
- `src/cli/feedback-mark.ts` — mark-seen / forget / mark-all-seen（104 LOC）
- `src/cli/feedback-seen-store.ts` — load/persistSeenSet helpers（28 LOC）
- `src/cli/feedback.test.ts` — 14 cases（7 list/show + 7 dedup）
- `src/cli.ts` dispatch + HELP

## 不做

- 状态推到 service（CLI 纯本地读，与 service 解耦）
- 多列 sort / column 控制（输出格式固定）
- prune 策略（未来按需加）
- search over body / ops 内容（grep over title only 看实际需求）
