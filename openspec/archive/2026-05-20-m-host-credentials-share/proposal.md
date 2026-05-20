---
status: archived
shipped_at: 2026-05-20
final_direction: D10 (anthropic 2026-02 policy reversal — container-issued
  CLAUDE_CODE_OAUTH_TOKEN + direct anthropic, proxy retained as fallback)
---

# Proposal: m-host-credentials-share — 补 shared-container jsonl/state mount + defense in depth

## Intent

m-user-shared-container (Phase 2, archive `2026-05-18-m-user-
shared-container`) ship 时 user spawn 路径已 wire 进 m-anthropic-
proxy:

- session-runtime spawn shared-container user 时注入 `ANTHROPIC_
  BASE_URL=http://host.docker.internal:62276` + `ANTHROPIC_AUTH_
  TOKEN=<per-user bearer>`
- owner 真凭据 (OAuth subscription token, D8 amendment b37b54c)
  仅在 proxy 进程内存; container 内 user 永不可见
- 全 user 同等走 proxy, 不区分 trust 级别 — prompt injection 风
  险下 "信任 user" 也可能被诱导偷自己 environ; proxy 是 owner
  credentials 的唯一隔离层

但 m-user-shared-container ship 时遗漏两个 wire:

1. **jsonl ship gap**: 容器内 cc 把 jsonl 写到 `/home/<user>/
   .claude/projects/...` (CLAUDE_CONFIG_DIR=/home/<user>/.claude),
   host 上 ContainerUserSync 没 mount 这个 path 出 host. 结果:
   container lifecycle 结束 jsonl 丢, host 上 QuotaWatcher watch
   owner `~/.claude/projects/` 看不到任何 container user 的
   jsonl → **QuotaWatcher 对 shared-container user 实际不工作**.
2. **LLM-soft-norm 缺位**: container 内 user 通过 prompt injection
   让 cc tool 调用偷 bearer (env / proc) 完全可能. bearer 偷出
   去后受 proxy per-user quota 控制 (D6 trust model 接受), 但
   多一层 defense in depth (baked CLAUDE.md + permission deny)
   能进一步降低手滑 leak.

本 Change 补这两个 gap:
- D3-D5: 加 `userClaudeRoot` 单 mount, per-user 子目录 chmod
  0700 chown, ccJsonlPathOf + QuotaWatcher 按 runtime 决路径
- D6: baked CLAUDE.md + settings.json permission deny, ensureUser
  cp 进 user `.claude`

**proxy 不撤** (D1). 早期 draft (在 m-shared-container-workspace-
fix 分支 2ba8e71 planned 但未 implement) 提议撤 proxy + OAuth env
inject 进 container, 该方向被反转 — 见 D1 决策段.

## Scope

### 新增

**`userClaudeRoot` 单 mount**:
- schema `userClaudeRoot: z.string().default('<configDir>/user-
  claude')`
- ccanywhere boot 时 mkdir (mode 0755)
- SharedContainerManager `docker run` 加
  `-v <userClaudeRoot>:/var/lib/ccanywhere/user-claude:rw`
- 单一 mount, per-user 子目录在容器内创建 (不用 per-user 多
  mount, 不用 mount nesting)

**per-user 子目录**:
- ContainerUserSync.ensureUser 加 (docker exec):
  - `mkdir -p /var/lib/ccanywhere/user-claude/<user>`
  - `chown <uid>:<gid>` + `chmod 0700`
  - cp `/etc/ccanywhere/CLAUDE.md` →
    `/var/lib/ccanywhere/user-claude/<user>/CLAUDE.md`
  - cp `/etc/ccanywhere/settings.json` →
    `/var/lib/ccanywhere/user-claude/<user>/settings.json`

**session-runtime overlay 调**:
- `CLAUDE_CONFIG_DIR=/home/<user>/.claude` (现状)
- → `CLAUDE_CONFIG_DIR=/var/lib/ccanywhere/user-claude/<user>`
- cc 找 jsonl: `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/
  <session-id>.jsonl` → host view
  `<userClaudeRoot>/<user>/projects/...`
- cc 找 settings: `$CLAUDE_CONFIG_DIR/settings.json` → host view
  `<userClaudeRoot>/<user>/settings.json`

**ccJsonlPathOf 加 root 参数**:
- 现签名 `ccJsonlPathOf(cwd, sessionId)` 写死 `homedir()/.claude`
- 新签名 `ccJsonlPathOf(cwd, sessionId, claudeRoot)` 接受 root
- 调用方按 session.runtime 传:
  - `host` (owner): `homedir()/.claude` 老路径不变
  - `shared-container`: `<userClaudeRoot>/<user>`

**QuotaWatcher 按 runtime 决路径**:
- watcher start 时根据 session.user.runtime + username 决 root
- 路径计算用新 ccJsonlPathOf 签名

**baked image files**:
- `docker/CLAUDE.md`: user 视角 instruction "你在 ccanywhere
  shared container 内, 禁止 env / Bash 输出含 ANTHROPIC_AUTH_
  TOKEN 的字符串"
- `docker/settings.json`: permission deny rules
- Dockerfile COPY 两个 → `/etc/ccanywhere/`

### 不动

- proxy 模块 (D1 不撤)
- session-runtime spawn 走 proxy 的 env inject (现状保留)
- m-anthropic-proxy archive (不标 superseded)
- SharedContainerManager / DockerDetector lifecycle
- workspace mount (D9 amendment 已 ship, container.workingDir
  仍 wire)
- m-user-runtime-schema (isolationPolicy / runtime field 不动)
- entrypoint.sh hosts override + iptables (反 prompt injection
  防 user 直连 anthropic.com 绕 proxy, 仍要)

## 决策

### D1. proxy 保留, 不撤 (反转 v1 draft)

早期 draft (2ba8e71 planned proposal) 提议撤 proxy 整套 + 改用
OAuth env inject 进 container. 反转理由:

**prompt injection 风险贯穿所有 user (含 "信任" 的 owner alt
account)**. 给任何 user 直接 inject owner OAuth token 到 container
env (`CLAUDE_CODE_OAUTH_TOKEN`), user 容器内 cc 一次被 prompt
injection 诱导 `env` / `cat /proc/self/environ` / 写 jsonl content
= owner OAuth token 立刻泄. permission deny defense in depth 可挡
直接 `Read(**/.credentials.json)`, 挡不住 `Bash(env)` (deny rule
必漏边).

proxy 路径下:
- container 内 user 见到的是 `ANTHROPIC_AUTH_TOKEN=<per-user
  bearer>`, 不是 owner OAuth
- bearer TTL 5min (m-anthropic-proxy D2), 偷出去后短期失效
- 偷出去的 bearer 仍受 proxy per-user quota / metering 控制
- owner OAuth token 只在 proxy 进程内存, container 永不可见

**"信任" 不该是"token 可见"的依据** — 信任只是"不会主动恶意",
但 prompt injection 是 third-party 攻击, 不依赖 user 主观恶意.
全 user 同等走 proxy 才符合安全前提.

代价: proxy 多一跳 local hop (~5-10ms, 可忽略). proxy 模块
~1700 LOC 持续维护成本 (Anthropic API 升级时偶尔同步).

### D2. trust model 显式: token 不分 trust, fs 共享 acceptable

m-anthropic-proxy D6 写 "owner + user 共享同一 subscription
quota" 是计量层面的 trust assumption. m-host-credentials-share
进一步显式:

- **token visibility**: 全 user 同等不可见 owner credentials
  (proxy 隔离, D1)
- **inter-user fs**: shared-container 内 user 间 filesystem
  共享 (`/tmp`, workspace mount root). user A 能 write `/tmp`
  影响 user B; user A workspace 跟 user B workspace 同一 mount
  root 下不同子目录, 越界 read 取决于 mode (workspace D9
  amendment 用 `<workspace>/<username>/` 子目录).
- **inter-user jsonl/state**: 本 Change 加 per-user 子目录
  chmod 0700 chown (D3/D4). **⚠ macOS docker desktop 实测
  (P9 Step A) bind mount 不 enforce inode permission** —
  container 内 mode 0700 是 cosmetic, user 间 jsonl/
  settings/CLAUDE.md 在 macOS 部署下**互相可 read/write**.
  linux host 部署下 chmod 0700 真 enforce (kernel mount
  正常). owner 信任群体 (alt account / collaborator) 假设
  下 macOS 不 enforce acceptable; 真陌生 user 要 isolated-
  container reserved.
- **prompt injection**: 信任级别不影响. 全 user 视 bearer 为
  可能 leak, defense 是 TTL + per-user quota cap (proxy 层)
  + baked CLAUDE.md/deny (LLM/tool soft norm, D6).

不可信外部 user (真陌生人) 仍 reserved `m-user-isolated-
container`. 本 Change 假设 user 群体是 owner 自己 + owner 已知
身份 (alt account / collaborator), 不是公开开放注册.

### D3. 单 mount userClaudeRoot + per-user 子目录 (vs per-user 多 mount)

候选方案:

**a. per-user docker -v** (撤回):
- spawn 时动态加 `-v <userClaudeRoot>/<user>:/home/<user>/
  .claude:rw`
- shared container 是 long-running, spawn 时不能动态加 mount
- 要 per-user container = 不符 shared-container 架构

**b. 单 mount 根目录** (采用):
- ccanywhere boot 时 SharedContainerManager docker run 一次性
  `-v <userClaudeRoot>:/var/lib/ccanywhere/user-claude:rw`
- per-user 子目录在容器内 `docker exec mkdir -p ... && chown
  ... && chmod 0700` (ContainerUserSync.ensureUser)
- 新 user 不需要重启 container, 子目录在容器内动态创建
- 单一 mount point, 简单, 无 mount nesting 风险

权衡:
- (+) 单 mount, ccanywhere lifecycle 简化
- (+) 新 user 无需 container restart
- (-) 容器内 `/var/lib/ccanywhere/user-claude/` 列表能看到所有
  user 名字 (dir mode 0755) — 不算 secret leak, user 名是
  schema config 明文
- (-) **⚠ macOS docker desktop 实测 (P9 Step A): bind mount
  不 enforce inode permission** — per-user 子目录 0700 在
  macOS 部署下不真隔离 inter-user; D2 trust model 接受作
  cosmetic, 真陌生 user 走 isolated-container reserved.
  linux 部署下 0700 真 enforce.

### D4. per-user 子目录 chmod 0700 chown (cosmetic on macOS, enforce on linux)

容器内:
- `/var/lib/ccanywhere/user-claude/` (mount point) mode 0755,
  owner = root (docker mount 时跟 host 的 uid map, macOS 
  desktop 通常 root)
- `/var/lib/ccanywhere/user-claude/<user>/` (子目录) mode 0700
  chown `<uid>:<gid>` (从 ContainerUserSync.ensureUser 的
  useradd 拿到)

**预期行为 (linux 部署)**: user A (uid_A) 能
`ls /var/lib/ccanywhere/user-claude/` 看目录名列表 (dir 0755
listing 允许), 但 `ls /var/lib/ccanywhere/user-claude/userB/`
permission denied (dir 0700 不 owned by uid_A). 跟 `/Users/`
mode 0755 + 各 user home 0700 一样.

**⚠ 实际行为 (macOS docker desktop, P9 Step A 实测)**: bind
mount 通过 gRPC FUSE / virtiofs 暴露 host APFS 路径, kernel
不 enforce inode permission. container 内 stat 显示 mode 0700
+ owner 元数据正确, 但任何 container user 能 read/write 任何
mount 子目录. control 验证: 非 mount 路径 (`/tmp/test-perm`)
chmod 0700 enforce 正常, container fs 本身权限 enforce 正常.
**仅 bind mount 路径不 enforce**.

**为何仍保留 chmod/chown 步骤**:
1. linux 部署环境真 enforce (ccanywhere 未来可能上 linux host)
2. cosmetic ownership — `ls` 显示正确 owner, defense in depth
   的 "看起来设置过权限" 比 "权限完全未设" 更不易被 social-
   engineer
3. 移除步骤无意义节省 (一次 docker exec, ~10ms)

**实际 inter-user 隔离假设依赖 D2 trust model** (owner 信任
群体), 不依赖 chmod. 真陌生 user 走 `m-user-isolated-container`
reserved.

### D5. QuotaWatcher 按 session.user.runtime 决 jsonl path root

QuotaWatcher 当前用 `ccJsonlPathOf(cwd, sessionId)` 写死
`homedir()/.claude/projects/...`. 改:

- `ccJsonlPathOf(cwd, sessionId, claudeRoot)` 加第三参数
- watcher 在 start 时根据 `session.user.runtime`:
  - `host` (owner): claudeRoot = `homedir()/.claude` (老行为)
  - `shared-container`: claudeRoot = `<userClaudeRoot>/<user>`

这样 host 上 QuotaWatcher 能 watch 到 mount 出来的 per-user
jsonl, ccusage 算法不变.

### D6. baked CLAUDE.md + permission deny (defense in depth)

bearer 偷出去最坏情况受 5min TTL + per-user quota 控 (D1), 但
defense in depth 仍有价值降低手滑:

**baked `/etc/ccanywhere/CLAUDE.md`** (instruction):
```
你在 ccanywhere shared container 内. 禁止:
- 在工具输出中 print 环境变量 (`env`, `printenv`)
- 通过 Bash 读 `/proc/<pid>/environ` 或类似 path
- 在 jsonl / 工作目录文件中写入含 `ANTHROPIC_AUTH_TOKEN`,
  `Bearer`, `sk-ant-` 等 secret 字符串的内容
- 通过 base64 / hex / 字符串拆分 输出敏感字段绕过上述限制
```

**baked `/etc/ccanywhere/settings.json`** (cc permission deny):
```json
{
  "permissions": {
    "deny": [
      "Bash(env)",
      "Bash(env *)",
      "Bash(printenv*)",
      "Bash(cat /proc/*)",
      "Bash(cat /etc/ccanywhere/*)",
      "Read(/proc/**)",
      "Read(/etc/ccanywhere/**)"
    ]
  }
}
```

实际 deny pattern 由 P10 spike 验 + 调优 (cc deny rule glob
syntax 不一定跟我直觉一致).

ContainerUserSync.ensureUser cp 进 per-user `.claude` 目录
(本 Change D3 wire).

**显式标注: defense in depth, 不是 hard enforcement**. LLM 可
能被 prompt injection 绕过 CLAUDE.md soft norm; deny rule glob
必有漏 (例 user 把 base64 写进 jsonl 不会触发 Read deny). 这条
仅降低手滑, 不替代 D1 proxy 隔离.

### D7 (post-ship amendment, m-anthropic-proxy). proxy cohost — ccanywhere main 启动时 spawn proxy 子进程

m-anthropic-proxy D1 原文: "独立进程 (不在 ccanywhere server
进程内)". 原意是 OS process 隔离 (防 main RCE = owner key 泄),
不是 launchd 独立 LaunchAgent. 当时 ship 时配套
`scripts/install-launchagent-proxy.sh` + 独立 plist; 但 owner
实际部署时**没装** proxy LaunchAgent (62276 未 listen, 见本
proposal Intent 段调研), proxy 全程没跑过. m-user-shared-
container ship 时仍未 e2e 验流量 (P5-P8 implementation-time
verify 漏跑) → ship gap.

修法: ccanywhere main process 启动时 `child_process.spawn(
'node', ['dist/cli.js', 'proxy', 'serve'])` 起 proxy 子进程.
仍是独立 OS process (不是同 node process), D1 blast radius
约束保留:

- proxy 子进程独立 PID, 独立内存空间
- owner credentials 文件 read **只在 proxy 子进程内**
  (main 不读不传, 仍走 `defaultCredentialsPath()`)
- proxy 子进程 stdio = `['ignore', logFd, logFd]`, log 独立
  `<configDir>/proxy.log`
- main 收 SIGTERM → 先 SIGTERM proxy 子进程 → wait grace
  (5s) → SIGKILL → 自己 exit
- proxy 子进程 crash 时 main 重启它 (mini supervisor); 连续
  N 次 (5) 短期 (60s) 失败放弃 + log fatal, main 继续跑
  (proxy 死了 shared-container session spawn 会 fail, 但
  owner host 路径仍能用)

变化对 D1 blast radius 假设:
- (+) main RCE 不直接拿到 proxy 内存里的 owner credentials
- (+) 部署 ux: 装一个 LaunchAgent = 都跑起来, 不会忘装
- (-) lifecycle 绑定: main 重启 → proxy 也重启 (acceptable,
  没人需要单独重启 proxy)
- (-) main 进程 RCE 仍能 `kill proxy_pid` (DoS), 但 owner
  credentials 不暴露 (D1 核心保证不破)

**替代方案撤回**:
- B. 两个独立 LaunchAgent (现状): 部署 ux 差, 容易忘装,
  evidence: 实际 ship 后 owner 就忘了
- C. 同 node process (两个 fastify instance): 违 D1,
  credentials 跟 main 共享 V8 heap, 任何 main 漏洞 = 泄
- D. (无)

`scripts/install-launchagent-proxy.sh` + 独立 plist 删除 (D7
后不再需要); `docs/deployment-proxy.md` §2 (LaunchAgent
安装段) 改写为 "由 main process 自动 spawn".

### D10 (post-deploy reversal). anthropic 2026-02 政策禁第三方 proxy OAuth Bearer → 撤回 proxy user-spawn wire, 改 mount OAuth env 进容器

**触发**: e2e dogfood 8 次反馈 cycle 后 (C5b-C5h 修了 binary path /
TLS handshake / auth conflicts / ZlibError / X-Api-Key), 仍 stuck
在 `401 Invalid bearer token`. proxy forward 用 owner OAuth bearer
调 anthropic /v1/messages 直接被 anthropic 拒.

WebSearch 找到决定性证据 ([anthropics/claude-code#28091](
https://github.com/anthropics/claude-code/issues/28091)): **Anthropic
2026-02-20 起明确禁止第三方应用通过 Authorization Bearer 用 OAuth
subscription token (`sk-ant-oat-...`)**. cc binary 自身仍可用是因
为 cc 是 anthropic 自家 first-party; 任何 proxy 转发都被 anthropic
识别为 third-party (大概率通过 TLS client fingerprint / cc-internal
beta header combo). 没有 workaround.

**owner 约束**: 只接受复用 Claude Pro/Max plan, 不愿用 Console API
key (烧 credit 不复用 subscription).

**唯一可行架构**: 容器内 cc binary 自己直连 anthropic. cc binary
是 anthropic 自家 → OAuth Bearer 允许 + cc 知道完整 beta header
combo. owner OAuth token 通过 `CLAUDE_CODE_OAUTH_TOKEN` env (cc
官方支持, 文档明确) 注入 container 内 cc 进程.

**反转 D1**: 撤 user-spawn 路径上的 proxy wire. 容器内 cc 不再调
`http://host.docker.internal:62276` (proxy), 改直连 `api.anthropic
.com`. proxy 模块代码**保留**作 future fallback (anthropic 政策
改 / owner 切 Console key 时可恢复), 但 spawn 不 wire 它.

**新流量路径**:
```
host:
  owner ~/.config/ccanywhere/anthropic-credentials.json
    (D8 amendment: {"oauthToken": "sk-ant-oat-..."} mode 0600)
  ↓ ccanywhere main read at boot
  ↓ inject via docker exec -e CLAUDE_CODE_OAUTH_TOKEN=...
container (cc binary spawned by docker exec):
  cc 看 CLAUDE_CODE_OAUTH_TOKEN env → 直连 api.anthropic.com
  ↓ 走 owner Pro/Max plan quota (anthropic-side first-party)
```

**反转 D5/D7 mount path**: cc 默认 `~/.claude/.credentials.json`
是 nested `{"claudeAiOauth": {accessToken, refreshToken, expiresAt,
scopes}}` shape. 我们 `anthropic-credentials.json` 是 flat
`{"oauthToken": "sk-ant-oat-..."}`. 不写 .credentials.json 文件,
走 cc 的 `CLAUDE_CODE_OAUTH_TOKEN` env var path (cc 文档:
"CLAUDE_CODE_OAUTH_TOKEN 优先于 .credentials.json"). 1 年期 long-
lived token, 不需要 refresh.

**安全代价 (D6 trust model 显式接受)**:
- container 内 cc 进程 environ 含 owner OAuth token
- user 通过 prompt injection 让 cc 调 Bash `cat /proc/<pid>/environ`
  / `printenv` 可见 token
- baked CLAUDE.md + permission deny (D6) 提供 LLM-soft + tool-
  layer hard 双层 defense in depth, 不替代 trust model
- D6: shared-container user **必须**是 owner alt account /
  collaborator. 真陌生 user reserved `m-user-isolated-container`

**变化范围**:
- 撤: session-runtime overlay 删 `ANTHROPIC_BASE_URL` + `CC_HELPER_
  TOKEN` inject; 加 `CLAUDE_CODE_OAUTH_TOKEN` inject (从 main
  load 的 owner credentials)
- 撤: ContainerUserSync 不 cp cc-helper.sh (image 仍 baked, 但
  per-user `.claude/` 不放它; settings.json 删 apiKeyHelper 字段)
- 撤: entrypoint.sh `/etc/hosts` override + iptables (允许容器
  直连 api.anthropic.com)
- 保留: proxy 模块代码 + cohost spawn (cohost 撤回是 LOC 浪费;
  proxy 仍 listen 但 user 不调; future re-enable backup)
- 保留: baked CLAUDE.md + permission deny (D6, defense in depth)
- 保留: per-user `~/.claude` mount root (D3, jsonl/sessions/settings
  per-user 仍要)
- 保留: ccJsonlPathOf + QuotaWatcher per-user wire (D5, quota
  monitoring 不依赖 proxy)

**替代撤回方案**:
- B. proxy 伪装 cc binary TLS fingerprint: cat-and-mouse, 政策违规
- C. owner 切 Console API key: owner 拒
- D. 放弃 shared-container 自动化: 跟项目目标冲突
- E. (无)

**形式化保证调整**:
- (撤) "owner OAuth/API key 不进 container env / fs" — 必须破,
  否则 cc 跑不通. D6 trust model 接受.
- (撤) "bearer leak ≤ 5min 窗口" — TokenIssuer 5min bearer 已不在
  user spawn 路径上.
- (撤) "bearer 偷出去受 per-user quota 控" — proxy enforce 不再 wire.
- (保留) "owner ~/.claude 不被 user 容器污染" — D4 per-user host
  path 仍 work.
- (新增) "owner OAuth token 通过 env 注入仅持续 cc spawn lifecycle"
  — docker exec -e 不持久 (container 内 PID 1 environ 不含 token).
- (新增) "anthropic 政策 first-party 限制下, 复用 OAuth subscription
  唯一可行路径" — D10 trust model 接受 prompt injection 风险.

**spike 验证 (待跑)**:
- 容器内 docker exec -u <user> -e CLAUDE_CODE_OAUTH_TOKEN=<owner OAuth> claude --print "say hi" 真返响应
- 验 owner Pro/Max quota 真扣 (Anthropic dashboard 比较)
- 验 jsonl 落 per-user host path (D5 仍 work)

## 落地点

| 文件 | 操作 |
|---|---|
| `src/config/schema.ts` | 加 `userClaudeRoot` field (default `<configDir>/user-claude`) |
| `src/cli/serve.ts` | boot 时 mkdir userClaudeRoot (0755); 传 perUserClaudeRoot 给 QuotaWatcher / SharedContainerManager; **D7: spawn proxy 子进程 + supervisor (crash respawn + SIGTERM 顺序 shutdown)** |
| `src/cli/proxy-serve.ts` | entry 不变 (子进程从此入口起); 移除独立 LaunchAgent 假设 |
| `src/container/shared-container.ts` (或同等) | docker run 加 `-v userClaudeRoot:/var/lib/ccanywhere/user-claude:rw` |
| `src/container/user-sync.ts` | ensureUser 加 mkdir 子目录 + chown + chmod 0700 + cp baked CLAUDE.md/settings.json |
| `src/server/routes/session-runtime.ts` | overlay CLAUDE_CONFIG_DIR 改 `/var/lib/ccanywhere/user-claude/<user>` |
| `src/quota/path.ts` | ccJsonlPathOf 加 `claudeRoot` 参数; runStartupSanityCheck 同步 |
| `src/quota/watcher.ts` | 按 session.user.runtime + perUserClaudeRoot 决 jsonl path |
| `src/server/routes/share.ts` | ccJsonlPathOf 调用方同步签名 |
| `docker/CLAUDE.md` (新) | baked instruction |
| `docker/settings.json` (新) | baked permission deny rules |
| `docker/Dockerfile.ccanywhere-user` | COPY CLAUDE.md/settings.json 进 `/etc/ccanywhere/` |
| `docker/entrypoint.sh` | 不动 (hosts override + iptables 仍要) |
| `scripts/container-manual-verify.sh` | 扩 P9 e2e step: docker exec claude --print "hi" 验真扣 quota + jsonl 落 per-user host |
| `docs/deployment-container.md` | 新加 §X userClaudeRoot 配置 + 文件布局; §Y trust model 显式 + defense in depth 说明 |
| `docs/deployment.md` | §8 (proxy) 改写 (proxy 由 main 自动 spawn, 不再独立 LaunchAgent); 加 §X userClaudeRoot 字段 (schema bump) |
| `docs/deployment-proxy.md` | §2 改写: LaunchAgent 安装段删, 改 "由 ccanywhere main 自动 spawn"; §1 (credentials) 保留 |
| `scripts/install-launchagent-proxy.sh` (如存在) | **delete** (D7) |
| `templates/com.<you>.ccanywhere-proxy.plist` (如存在) | **delete** (D7) |
| `~/.config/ccanywhere/proxy.log` (新, runtime) | proxy 子进程独立 log (main spawn 时 redirect stdio) |

预计 ~460 LOC src (含 D7 cohost ~80) + ~200 LOC test (含 D7
supervisor crash respawn) + ~60 LOC docs = 净 ~720 LOC. 比 v1
draft 估的 -700 LOC swing **+1420 LOC** (因 v1 是减 proxy
~1700 LOC), 但范围明确 + 修真实 ship gap.

## 形式化保证

| 性质 | 机制 |
|---|---|
| owner OAuth/API key 不进 container env / fs | D1 proxy 隔离 (现状), bearer 转发 |
| owner OAuth/API key 不进 ccanywhere main 进程内存 | D7 cohost — main spawn proxy 子进程, credentials 文件 read 仅在 proxy 子进程; D1 OS process 隔离保留 |
| proxy 部署不会被遗忘 | D7 cohost — 装 ccanywhere LaunchAgent 即 proxy 跟着起, 不再独立 plist |
| bearer leak ≤ 5min 窗口 | m-anthropic-proxy D2 短 TTL + apiKeyHelper rotation |
| bearer 偷出去受 per-user quota 控 | m-anthropic-proxy D3 按 response usage 算 + inline quota |
| user 间 jsonl/settings/CLAUDE.md 互不可读 | D4 per-user 子目录 0700 chown — **⚠ macOS docker desktop bind mount 不 enforce (P9 Step A 实测), 仅 linux 部署真生效**; macOS 下依赖 D2 trust model 信任群体假设 |
| QuotaWatcher 对 shared-container user 真工作 | D5 watcher 按 runtime + perUserClaudeRoot 决路径 |
| owner host 路径零回归 | D5 host runtime 走老 ccJsonlPathOf(homedir) |
| container 内 cc → proxy 流量真打通 | P9 spike 实测 (m-user-shared-container ship 时未 e2e 验证, 本 Change 补) |
| prompt injection 偷 bearer 一层防护 | D6 baked CLAUDE.md soft norm + permission deny hard layer (defense in depth, 不替代 D1) |
| inter-user workspace 隔离 | D9 amendment workspace mount per-user 子目录 (已 ship) |
| inter-user `/tmp` 不隔离 | D2 trust model 显式接受 (本 Change 不修, isolated-container reserved) |

## 不做

- 撤 proxy (D1 反转, 早期 draft 方向)
- per-user docker -v (D3 b 采用单 mount 替代)
- 改 m-anthropic-proxy 行为 (proxy 本身 OK, 仅 wire 调; D7
  改启动方式不改 proxy 内部)
- proxy 跟 main 同 node process (违 m-anthropic-proxy D1
  OS process 隔离假设, V8 heap 共享 = credentials 跟 main
  共内存)
- 独立 proxy LaunchAgent (D7 后由 main 自动 spawn, 装一个
  LaunchAgent 即 proxy 跟着起)
- inter-user `/tmp` 隔离 (D2 接受, isolated-container reserved)
- isolated-container 实现 (reserved `m-user-isolated-container`,
  真陌生 user 场景, 本 Change 范围外)
- pty 字符串截断 (leaky, BACKLOG `m-pty-secret-redact-best-
  effort`)
- macOS docker desktop 下真 inter-user fs 隔离 (gRPC FUSE/
  virtiofs 不 enforce inode perm, D4 实测; 真隔离要 loopback
  ext4 / qcow / VM, 复杂度高 — 留 `m-user-fs-isolation-macos`
  reserved, 真需要时再做)
- 自动 bearer 旋转优化 (m-anthropic-proxy 现有 5min TTL +
  apiKeyHelper 已 sufficient)
- automated permission deny pattern fuzz (P10 spike 一次手动
  调通即可, 未来 cc API 变再 revisit)

## 后续 follow-up (reserved, 不入本 change)

- m-user-isolated-container (per-user 真容器, 真陌生 user)
- m-pty-secret-redact-best-effort (best-effort 输出过滤, 知道
  会被 base64/split 绕过)
- m-host-keychain-sync (macOS Keychain → file 自动同步)
- m-anthropic-proxy-models (`/v1/models` 实现, m-anthropic-
  proxy D6 reserved)

## 前置 spike

- **P9 (新)**: 容器内 cc → proxy 真流量 e2e 验
  - 跑 `docker exec -u <user> -e CLAUDE_CONFIG_DIR=/var/lib/
    ccanywhere/user-claude/<user> -e ANTHROPIC_BASE_URL=http://
    host.docker.internal:62276 -e ANTHROPIC_AUTH_TOKEN=<bearer>
    <container> claude --print "say hi"`
  - 验:
    - anthropic 返响应 (subscription billing, owner OAuth quota
      扣)
    - jsonl 落 host path `<userClaudeRoot>/<user>/projects/...`
    - owner `~/.claude/projects/` 没被污染
    - host.docker.internal:62276 在容器内真可达
  - 失败回退: bind proxy 到 docker bridge IP (0.0.0.0 或 bridge
    gateway) 而不是 127.0.0.1
- **P10 (新)**: permission deny pattern 实测
  - baked settings.json 含候选 deny rules
  - user prompt 试图 read `/proc/self/environ` 看 cc 是否 deny
  - 试 bypass: `cat /proc/$(pidof claude)/environ`, base64 wrap,
    `printenv ANTHROPIC_AUTH_TOKEN`
  - 调 deny rule 直到主流 attack vector 防住
  - 文档列已知 bypass (defense in depth 非 enforcement, 显式标
    注边界)
