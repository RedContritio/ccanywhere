# ccanywhere — 项目级约束

跨项目通用工作风格在 `~/.claude/CLAUDE.md`。本文件只放 ccanywhere 特有的
强制约束。

## OpenSpec 是工作 source of truth

ccanywhere 所有工作（已 ship / 在做 / 待办 / 设计决策）都走 `openspec/`：

- **进行中**：`openspec/changes/<slug>/{proposal,tasks}.md`
- **已完成**：`openspec/archive/<YYYY-MM-DD>-<slug>/{proposal,tasks}.md`
- **稳定 spec**：`openspec/specs/<area>/spec.md`（Requirement + Scenario）

### 必跑流程（新 feature / bugfix）

1. **开工前**：建 `openspec/changes/<slug>/{proposal,tasks}.md`
   - proposal 含：Intent + 决策摘要 + 落地点 + 形式化保证 + 不做
   - tasks 含：可勾 checkbox + 关联 commit hash（ship 时回填）
2. **ship 时**：相关 spec area 同步 delta（Requirement + Scenario）
3. **完成后**：`mv openspec/changes/<slug> openspec/archive/<date>-<slug>`
4. **commit message body** 含 archive 路径 + spec delta 摘要

### 例外（可省 openspec）

- 纯 UX 小 fix（如删 autoFocus / CSS 微调）
- 测试代码 only（trace / regression test）
- 文档 typo / 格式
- CLAUDE.md / memory 调整

但**新功能 / 行为变更 / 破坏性改动**没 openspec = 缺陷。回顾发现遗漏要
立即 backfill archive（如 m-keyboard-resize / m-feedback-cli 归档补做）。

### 不要在 memory / 散文中维护

- 待办 backlog → `openspec/changes/` (大项) + `openspec/BACKLOG.md` (小项)
- 已 ship 列表 → `openspec/archive/` + `git log`
- 设计决策 → archive proposal "决策"段
- 形式化保证 → archive proposal "形式化保证"段
- 关键合约 → 对应 area 的 `specs/<area>/spec.md` Requirement

memory 仅保留**无法从 openspec/git 推导**的协作约定（feedback type rules）。

### 未启动 backlog 也必须落 OpenSpec

conversation 里出现的 todo / "后续" / 用户提的 "也想要 X" / 我建议的
follow-up — 全部**立即**落到：

- **大项**（≥80 LOC 或跨多 commit）→ 建 `openspec/changes/<slug>/proposal.md`
  + tasks.md，frontmatter `status: planned`（启动后改 `in-flight`）
- **小项 / 散点**（≤80 LOC，单笔可做）→ 在 `openspec/BACKLOG.md` append 一
  条，含**出处** / **scope 估算** / **优先级**

落地是规则不是建议。列 backlog 时直接 `ls openspec/changes/` +
`cat openspec/BACKLOG.md`，不靠 grep archive 散段 / git log / 我回忆。

启动 BACKLOG.md 里某项时，把它从 BACKLOG.md 删 + 建 `changes/<slug>/`（即便
~30 LOC 也建 proposal，统一流程）。

### 工具层硬约束：commit hook 强制 openspec 改动

`.husky/commit-msg` hook 强制每个 src/ 或 web/src/ 代码改动 commit
**必须**同笔含 openspec/ 改动（proposal / archive / spec delta / BACKLOG
任一）。**无 override，无 marker，无 test-only 豁免**。如果改动小到不
值得 spec edit，应折进对应的 proposal / archive / BACKLOG 条目说明为什么
落地。

软约束（CLAUDE.md 几条）已被工具化的：
- "未启动项必须落 OpenSpec" → commit hook 拦
- "spec drift 必须同步" → commit hook 拦
- "memory 不维护 backlog" → 仍是软约定（hook 不能查 memory）

## 在告诉用户 commit 之前，必须自己确认部署可用

ccanywhere 是 user 本机 LaunchAgent。web 改动 + cli 改动都要走完整部署
链路才能在浏览器真正可见。**仅源码改动不算 done**。

### 必跑序列（每次 commit 前，涉及 src/ 或 web/src/ 的改动）

```bash
pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm test
pnpm build:all                                                    # web/dist + dist/cli.js
launchctl kickstart -k gui/$(id -u)/com.redcontritio.ccanywhere   # respawn LaunchAgent
sleep 3 && curl -sf http://127.0.0.1:62275/healthz                # 必须返 200 {"ok":true}
```

healthz 200 之后才算"部署可用"。如果 200 但还有 UI 改动，要么自己抓
`curl -s /assets/index-*.js | grep <新 class>` 验证 bundle 含新代码，
要么让 user 浏览器验。**不能仅说 "已 build 没跑就 commit"。**

### 当 healthz 返非 200 / curl 拒连

立刻 `tail -40 ~/.config/ccanywhere/server.log` 看 fatal 原因。常见：

- `config validation failed: <field>: Required` — schema 加了必填字段但
  生产 `~/.config/ccanywhere/config.json` 没同步。docs/deployment.md 写
  了不算——**必须**在 ship schema bump 的同笔 commit 里：
  1. 告诉 user 加哪行 / 帮 user 加（需要 user 授权写 ~/.config/）
  2. kickstart 验 healthz 200 之后才能继续
- `claudeBin` 找不到 — config 用绝对路径
- `webOrigin` 非 URL — 校验失败

### 例外（不需要部署即可 commit）

- 仅 docs / openspec 改动（spec.md / proposal.md / tasks.md / README）
- 仅 test 文件改动
- 仅 CLAUDE.md / memory 更新

这些情况只跑 `pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm test`
就行。

## Prod config 改动前必须用户显式确认

`~/.config/ccanywhere/config.json` 是 user 本机的 prod 配置（含 prod
endpoint、claudeBin 路径、prod cookieName 等）。**任何写入这个文件之前
都要拿到用户明确许可**，单笔授权仅覆盖本次单次改动。

- 写入前一句话说清要加 / 改哪个字段、值是什么、为什么。
- 等 user 显式 "OK / 改 / 加" 之类的确认词。
- 一次授权一次写。本次写完就消费掉，下次再改要再问。
- 不能用"docs 已经说明了"作为绕开授权的理由。
- 备份不需要（user 自己 git / Time Machine 管理 dotfiles）。

理由：这是 user 唯一一份正在跑的实例配置，改错 service 立刻挂；user 可能
对 path / port / cookieName 有自己的偏好，机械按 schema default 写会破坏
他的 setup。

## Schema bump 必须同步 prod config

`src/config/schema.ts` 加新必填字段 = 破坏性变更：

- ship commit 必须含 docs/deployment.md 对应字段说明
- ship commit 必须**主动**让 user 同步 `~/.config/ccanywhere/config.json`：
  - 先按上一节流程请求授权
  - 写入后自己 deploy + healthz 验证（捕获用户 config 漏改的 fatal）
- 不能仅"docs 写了就完事"

历史教训：#44 m-multi-user (`8349fa7`) 加 `guestProjectsRoot` 必填；docs
写了但 prod config 没同步；同笔 ship 没自己 deploy 验证。结果一周后下次
`launchctl kickstart` 时服务起不来——root cause 早被埋下，触发延迟才暴露。
