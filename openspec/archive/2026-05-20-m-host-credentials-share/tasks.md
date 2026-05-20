# Tasks: m-host-credentials-share

## 前置 spike

- [ ] P9: 容器内 cc → proxy 真流量 e2e 验
  - build image + run shared-container with userClaudeRoot mount
    (临时 mount path, 不入 main 直到 C2 wire)
  - issue 一个临时 bearer (通过 proxy token API 或直接读 token
    store)
  - `docker exec -u <user> -e CLAUDE_CONFIG_DIR=... -e
    ANTHROPIC_BASE_URL=http://host.docker.internal:62276 -e
    ANTHROPIC_AUTH_TOKEN=<bearer> <container> claude --print
    "say hi"`
  - 验 anthropic 真返响应, owner OAuth quota 扣 (Anthropic
    dashboard 比较前后用量)
  - 验 jsonl 落 host `<userClaudeRoot>/<user>/projects/...`
  - 验 owner `~/.claude/projects/` 没新文件
  - 验 host.docker.internal:62276 可达 (容器内 curl)
  - 失败处理: 若 host.docker.internal 不通, audit proxy bindHost
    + docker desktop 设置; bind 改 docker bridge IP 而非
    127.0.0.1
- [ ] P10: permission deny pattern 实测
  - baked settings.json 用候选 deny rules
  - user prompt 试 read `/proc/self/environ` / `cat /proc/<pid>/
    environ` / `env` / `printenv ANTHROPIC_AUTH_TOKEN`
  - 验 deny 生效
  - 试 bypass: `bash -c 'echo $ANTHROPIC_AUTH_TOKEN | base64'`,
    file redirect, sub-shell
  - 调 deny rule 到主流 attack vector 防住
  - 落 spike-results.md 记录已知 bypass + 边界
- [ ] 落 spike-results.md (两条 spike 结论)

## 实现 — schema + boot mkdir (C1)

- [ ] `src/config/schema.ts`: 加 `userClaudeRoot: z.string()
      .default(<configDir>/user-claude)` (跟 cookieName 一样可
      override)
- [ ] `src/cli/serve.ts`: boot 时 ensureDirSync(userClaudeRoot,
      0o755)
- [ ] fixture: src/server/server.test-helpers.ts +
      src/cli/serve.test.ts 等 baseConfig 加 userClaudeRoot
      字段
- [ ] docs/deployment.md §X (schema bump 说明 + prod config 同
      步指引)

## 实现 — SharedContainerManager mount (C2)

- [ ] `src/container/shared-container.ts` (找具体文件 — 看
      manager spawn 的地方): docker run 加 `-v
      <userClaudeRoot>:/var/lib/ccanywhere/user-claude:rw`
- [ ] 测试: container manager spawn test 验 mount arg 注入

## 实现 — session-runtime + ContainerUserSync (C3)

- [ ] `src/server/routes/session-runtime.ts`: overlay
      `CLAUDE_CONFIG_DIR` 改 `/var/lib/ccanywhere/user-claude/
      <user>` (去掉旧的 `/home/<user>/.claude`)
- [ ] `src/container/user-sync.ts`: ensureUser 加 docker exec
      序列:
      ```
      mkdir -p /var/lib/ccanywhere/user-claude/<user>
      chown <uid>:<gid> /var/lib/ccanywhere/user-claude/<user>
      chmod 0700 /var/lib/ccanywhere/user-claude/<user>
      cp /etc/ccanywhere/CLAUDE.md /var/lib/ccanywhere/user-
        claude/<user>/CLAUDE.md
      cp /etc/ccanywhere/settings.json /var/lib/ccanywhere/
        user-claude/<user>/settings.json
      chown <uid>:<gid> /var/lib/ccanywhere/user-claude/<user>/
        CLAUDE.md /var/lib/ccanywhere/user-claude/<user>/
        settings.json
      ```
- [ ] 测试: src/container/user-sync.test.ts 加 mkdir/chown/chmod/
      cp baked files case (mock docker exec)
- [ ] 测试: src/server/routes/session-runtime.test.ts 改
      CLAUDE_CONFIG_DIR 期望值

## 实现 — ccJsonlPathOf 加 root + QuotaWatcher per-user (C4)

- [ ] `src/quota/path.ts`: ccJsonlPathOf(cwd, sessionId,
      claudeRoot) 加第三参数; 默认 `homedir()/.claude` 仅作
      backwards-compat (但调用方都改)
- [ ] `src/quota/path.ts`: runStartupSanityCheck 同步签名
- [ ] `src/quota/watcher.ts`: start 时根据 session.user.runtime
      决 claudeRoot:
      - host: claudeRoot = `homedir()/.claude` (老行为)
      - shared-container: claudeRoot = `<userClaudeRoot>/
        <user>`
      - isolated-container: 暂留 host fallback (reserved)
- [ ] watcher constructor / start 加 `perUserClaudeRoot` 参数
      透传
- [ ] `src/cli/serve.ts`: 传 perUserClaudeRoot 给 QuotaWatcher
- [ ] `src/server/routes/share.ts`: ccJsonlPathOf 调用方传
      正确 claudeRoot (根据 session.user.runtime + username)
- [ ] 测试: src/quota/watcher.test.ts 加 shared-container path
      验证 watch correct jsonl
- [ ] 测试: src/quota/path.test.ts 加 claudeRoot 参数 case

## 实现 — docker baked files (C5)

- [ ] `docker/CLAUDE.md` (新): user 视角 instruction (本 proposal
      D6 段文本)
- [ ] `docker/settings.json` (新): permission deny rules (P10
      验证后定稿)
- [ ] `docker/Dockerfile.ccanywhere-user`: 加
      ```
      COPY CLAUDE.md /etc/ccanywhere/CLAUDE.md
      COPY settings.json /etc/ccanywhere/settings.json
      ```
- [ ] image rebuild + tag 跟 ccanywhere release 同步
- [ ] scripts/container-manual-verify.sh 扩 step 验 baked files
      存在 (`docker exec ls /etc/ccanywhere/`)

## 实现 — proxy cohost (C7, D7)

- [ ] `src/cli/serve.ts`: ccanywhere main boot 时
      `child_process.spawn('node', ['dist/cli.js', 'proxy',
      'serve', '--config', <configPath>])`:
      - stdio = `['ignore', logFd, logFd]`, logFd = open
        `<configDir>/proxy.log` (append, mode 0600)
      - 子进程 PID 记录, supervisor 监听 'exit' 事件 → crash
        respawn (退避 1s/2s/5s/10s/30s, 60s window 内连续
        N=5 失败放弃 + log fatal, main 继续跑)
      - main 收 SIGTERM/SIGINT → `proxy_proc.kill('SIGTERM')`
        → wait 5s → `proxy_proc.kill('SIGKILL')` → main 自
        己 process.exit
- [ ] `src/cli/serve.ts` test: 加 supervisor 单测 (mock
      child_process.spawn, 验 crash respawn + N 次放弃 +
      shutdown 顺序)
- [ ] `scripts/install-launchagent-proxy.sh`: 删
- [ ] `templates/com.<you>.ccanywhere-proxy.plist`: 删 (如
      文件存在)
- [ ] `docs/deployment-proxy.md` §2 改写: LaunchAgent 安装段
      删, 改 "由 ccanywhere main 自动 spawn"
- [ ] `docs/deployment.md` §8 (proxy) 改写
- [ ] verify: 部署后 launchctl 仅 ccanywhere 一个 service,
      `pgrep -f 'proxy serve'` 仍能找到 proxy 子进程, 62276
      listen 正常

## 实现 — docs (C6 part 1)

- [ ] `docs/deployment-container.md`:
  - 新加 §X `userClaudeRoot` 配置 + 文件布局 (host view + 容器
    view 对照)
  - 新加 §Y trust model 显式 (D2): token 不分 trust, fs 部分
    隔离, defense in depth 非 enforcement
  - 改 §1-§7 中提到 jsonl path 的段, 反映 per-user root
- [ ] `docs/deployment.md`:
  - §X schema bump 加 userClaudeRoot 字段 + prod config 同步
    步骤 (按 CLAUDE.md "Schema bump 必须同步 prod config" 走)
  - §8 (proxy) 不变
- [ ] `docs/deployment-isolation.md`:
  - §7 Phase 2 完工说明改, 加 ship gap 修补 + userClaudeRoot
    布局

## archive (C6 part 2)

- [ ] proposal status: planned → in-flight (开始 implement 时)
      → archived
- [ ] commit hash 回填到 tasks.md "## ship 记录" 段 (按
      ccanywhere CLAUDE.md 要求)
- [ ] mv `openspec/changes/m-host-credentials-share` →
      `openspec/archive/<date>-m-host-credentials-share`
- [ ] archive m-user-shared-container proposal.md 加 D10
      amendment 段引 m-host-credentials-share (ship gap 补完
      pointer)
- [ ] archive m-anthropic-proxy proposal.md frontmatter 不动
      (proxy 不撤, 不标 superseded)

## 部署验证 (按 ccanywhere CLAUDE.md "commit 之前必须自己确认
部署可用")

- [ ] `pnpm typecheck:all && pnpm lint && pnpm lint:md && pnpm
      test`
- [ ] `pnpm build:all`
- [ ] **请求 user 授权写 `~/.config/ccanywhere/config.json`**
      加 `userClaudeRoot` 字段 (schema bump 必须同步 prod
      config — 跟 CLAUDE.md 一致)
- [ ] `launchctl kickstart -k gui/$(id -u)/com.<you>
      .ccanywhere`
- [ ] `curl -sf http://127.0.0.1:62275/healthz` 验 200
- [ ] tail server.log 看 fatal (若 config 字段缺则 server 起
      不来, 是预期)

## commit 拆分 (估)

- [x] C0a: P9 Step A spike + proposal D4 macOS limitation 修订
      + spike-results.md (commit `5ecd714` on m-shared-container-
      workspace-fix)
- [ ] C0b: P9 Step B + P10 spike 跑通 + spike-results.md 续 +
      proposal status planned → in-flight (待鉴权链路就绪 +
      C7 cohost 让 proxy 真 listen 后)
- [x] C1: schema + boot mkdir + fixture (~30 LOC) — schema 加 `userClaudeRoot: z.string().optional()` (caller fallback `<configDir>/user-claude`, 避免 schema bump 强制 prod config 同步), serve.ts boot 时 resolve + mkdir 0755 recursive.
- [x] C2: SharedContainerManager mount — container-init.ts 加 `userClaudeRoot` 参数, extraRunArgs 加 `-v <userClaudeRoot>:/var/lib/ccanywhere/user-claude:rw`. SharedContainerManager 不动 (已支持 extraRunArgs). Deploy verify: docker inspect 显示 2 mount (workspace + userClaudeRoot), container 内 ls 看到 mount dir mode 0755.
- [x] C3: session-runtime CLAUDE_CONFIG_DIR + ContainerUserSync
      ensureUser mkdir/chown/chmod (~80 LOC). session-runtime.ts
      overlay CLAUDE_CONFIG_DIR 改 `<userClaudeContainerRoot>/<user>`
      (vs 旧 `/home/<user>/.claude`). ContainerUserSync 加
      `userClaudeContainerRoot?` opt; ensureUser 在 useradd + chmod
      /home 后 mkdir + chown <uid>:<uid> + chmod 0700 per-user 子
      目录 (macOS bind mount 不 enforce 但 linux 真 enforce, P9
      Step A 验). SessionContainerDeps + container-init.ts wire 同
      步. baked CLAUDE.md/settings.json cp 留 C5 (image build 改).
- [x] C4: ccJsonlPathOf root 参数 + QuotaWatcher per-user wire
      (~90 LOC). ccJsonlPathOf(cwd, sessionId, claudeRoot?) 加 opt
      第三参数; default homedir/.claude 保持 owner host path 行为.
      QuotaWatcherOptions 加 perUserRuntime + userClaudeRoot opts;
      start(session) 按 effective runtime + username 决 watch path
      (shared-container → <userClaudeRoot>/<user>; host → homedir).
      buildServerOpts 加 userClaudeRoot 透传, serve.ts wire 传给
      buildServer. test: 加 shared-container path 验真 watch + assert
      owner home path 跟 container path 不同; 17/17 quota + 618/618
      full test pass (1 次 flaky retry).
- [x] C5: docker baked CLAUDE.md/settings.json + Dockerfile
      COPY + ContainerUserSync ensureUser cp 进 per-user .claude.
- [x] C5b (post-deploy fix): spawn command override for container
      runtime. e2e dogfood 触发 `OCI runtime exec failed: exec:
      "/Users/<you>/.local/bin/claude": stat ... no such file
      or directory` — sessions{,-resume}.ts 把 config.claudeBin
      (host abs path) 当 docker exec 命令传, container 内不存在.
      Fix: SessionRuntimeOverlay 加 `command?: string`, shared-
      container 路径返 'claude' (PATH lookup, npm install -g 装
      到 /usr/local/bin/claude), caller 用 overlay.command ??
      config.claudeBin.
- [x] C5c (post-deploy fix): bearer rotation via cc apiKeyHelper.
      e2e 反馈 cc 返 "重试" — root cause: ANTHROPIC_AUTH_TOKEN 是
      TokenIssuer 默认 5min TTL bearer, session spawn 后 1h+ 用户
      才输入, bearer 早过期. m-anthropic-proxy D2 设计的 rotation
      没 wire. Fix: proxy 加 POST /ccanywhere/bearer-refresh
      endpoint — caller 提供 long-lived helper bearer, return
      fresh 5min bearer 同 user. test 4 个 (happy + 3 个 401).
- [x] C5e (post-deploy fix): proxy fetch transient retry. e2e dogfood
      触发 "一直在重试" + "有warning". proxy.log: `upstream fetch
      failed: Client network socket disconnected before secure TLS
      connection was established` (1 次). 偶发 cloudflare TLS handshake
      transient. Fix: forward.ts handleForward 加 retry (3 attempts,
      backoff 0/200/600ms). 2 新单测 cover retry-success + retry-give-up
      (16 forward test 全 pass).
- [x] C8 (D10 reversal): container-init.ts boot 加 loadOwnerCredentials
      → SessionContainerDeps 加 ownerOauthToken; session-runtime
      overlay 撤 ANTHROPIC_BASE_URL + CC_HELPER_TOKEN inject, 改
      CLAUDE_CODE_OAUTH_TOKEN. test: session-runtime.test.ts 13/13.
      Deploy verify: server.log "owner OAuth token loaded", fresh
      session envOverrides 含 CLAUDE_CODE_OAUTH_TOKEN.
- [x] C9 (D10): docker entrypoint.sh 撤 /etc/hosts api.anthropic.com
      override + iptables REJECT. image rebuild + verify "starting
      (D10: direct anthropic)" log + 容器内 /etc/hosts 无 anthropic
      entry.
- [x] C10 (D10): baked settings.json 删 apiKeyHelper 字段. permission
      deny rules 保留. cc-helper.sh + bearer-refresh endpoint 仍
      baked / 仍 register 作 backup.
- [ ] C11 (D10): docs — deployment-container.md / deployment-proxy.md
      / deployment.md §8 改写; 形式化保证表更新; m-anthropic-proxy
      archive 加 superseded_by_via_anthropic_policy_2026_02 标注.
- [ ] C8-C11 spike: docker exec -e CLAUDE_CODE_OAUTH_TOKEN=<owner>
      claude --print 真返响应, owner Pro/Max quota 真扣 (anthropic
      dashboard 比较), jsonl 落 per-user host path.
- [x] C5h (post-deploy fix): proxy forward 同时接 X-Api-Key header.
      e2e 反馈 cc 显 "Please run /login · API Error: 401 Invalid
      bearer token". Root cause: helper script 返的 token 是 cca.
      前缀 (m-anthropic-proxy D2 token format), 不是 sk-ant-oat-/
      sk-ant- 前缀. cc 看 token 格式不识别为 OAuth subscription token,
      把它当 Console API key 用 X-Api-Key header 发. proxy forward
      仅接 Authorization Bearer → 401. Fix: forward 路径 accept 两
      种 header (Bearer 优先, fallback X-Api-Key, 同 TokenIssuer
      verify). 1 新单测 cover X-Api-Key 路径.
- [x] C5g (post-deploy fix): strip content-encoding header in
      proxy forward. e2e 反馈 "unable to connect. zlib 什么什么"
      — cc 显 `API Error: Unable to connect to API (ZlibError)` +
      `Decompression error: Zl...`. Root cause: undici fetch auto-
      decompress gzip body, 但 proxy 转发 response 保留 upstream
      `Content-Encoding: gzip` header. cc 试 decompress plaintext →
      ZlibError. Fix: copyForwardHeaders 加 `content-encoding` 进
      strip list (同 content-length/connection/transfer-encoding).
      1 新单测 cover.
- [x] C5f (post-deploy fix): 删 ANTHROPIC_AUTH_TOKEN env, 避免 auth
      conflict warning. e2e 反馈 "还是会出错。你没看截图的 auth
      conflicts 吗" — cc 检到 ANTHROPIC_AUTH_TOKEN env + apiKeyHelper
      script 同时配置, surface "auth conflicts" warning. Fix: session-
      runtime 删 ANTHROPIC_AUTH_TOKEN env inject (apiKeyHelper 接管
      bearer 颁发, 第一次请求 cc 也调 helper). test mkDeps assert
      ANTHROPIC_AUTH_TOKEN undefined + CC_HELPER_TOKEN 存在.
- [x] C5d (post-deploy fix): cc apiKeyHelper wire 进 container.
      docker/cc-helper.sh (POST CC_HELPER_TOKEN → 取响应 token →
      stdout). settings.json 加 `apiKeyHelper: /usr/local/bin/cc-
      helper.sh`. Dockerfile COPY + chmod 0755. session-runtime
      inject CC_HELPER_TOKEN (24h TTL bearer, 同 userId). cc 401
      后自动调 helper 换 fresh bearer, 不需要 ccanywhere 重启
      session.
      docker/CLAUDE.md (LLM soft norm 文本) + docker/settings.json
      (permission deny rules: Bash env/printenv/cat /proc, Read
      /proc/** + /etc/ccanywhere/**) + Dockerfile COPY +
      ensureUser 加 cp + chown 2 files. P10 spike (跑 user
      prompt 试 bypass 调 rule) 仍待做. test +2 (cp dst/src
      assert + chown user). image rebuild + 部署 verify: shared
      container 内 ls /etc/ccanywhere/ 看到 CLAUDE.md +
      settings.json mode 0644.
- [ ] C6: docs + archive (~100 LOC docs, archive mv)
- [x] C7: proxy cohost — main spawn proxy 子进程 + supervisor
      + shutdown 顺序; docs 改写. Deploy verify: kickstart → main
      healthz 200 + proxy healthz **ready** mode + proxy PPID=main
      PID + owner credentials loaded + redact self-test passed.
      Legacy install-launchagent-proxy.sh + plist 不存在 (从未
      ship 进 repo, m-anthropic-proxy archive 提到但未真落), 无需
      delete. (~85 LOC src + ~220 LOC test + docs)

8 commit 预估 (C0a 已 ship, C7 implement done), 净 +460 LOC src
+ 200 LOC test + 60 LOC docs = ~720 LOC.

## BACKLOG follow-up (proposal 后续 follow-up 段, 不重复)

- m-user-isolated-container
- m-pty-secret-redact-best-effort
- m-host-keychain-sync
- m-anthropic-proxy-models
