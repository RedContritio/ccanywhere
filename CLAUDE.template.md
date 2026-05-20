# ccanywhere — 项目级约束 (模板)

> 这是 `CLAUDE.md` 的脱敏模板。本仓库的真正 `CLAUDE.md` 不入版本控制
> (见 `.gitignore`),要用的话:
>
> ```bash
> cp CLAUDE.template.md CLAUDE.md
> # 然后把 com.<you>.ccanywhere 替换成你自己的 launchd label
> ```
>
> 或者拷到 claude code 的 per-project 路径让它自动加载:
>
> ```bash
> cp CLAUDE.template.md ~/.claude/projects/$(pwd | sed 's|/|-|g')/CLAUDE.md
> ```

跨项目通用工作风格在 `~/.claude/CLAUDE.md`。本文件只放 ccanywhere 特有的
强制约束。

## 在告诉用户 commit 之前，必须自己确认部署可用

ccanywhere 是 user 本机 LaunchAgent。web 改动 + cli 改动都要走完整部署
链路才能在浏览器真正可见。**仅源码改动不算 done**。

### 必跑序列（每次 commit 前，涉及 src/ 或 web/src/ 的改动）

```bash
pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm test
pnpm build:all                                                    # web/dist + dist/cli.js
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere   # respawn LaunchAgent
sleep 3 && curl -sf http://127.0.0.1:8081/healthz                # 必须返 200 {"ok":true}
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

- 仅 docs 改动（README / docs/）
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
