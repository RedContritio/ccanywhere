# Tasks: m-user-shared-container

## 前置

- [x] Phase 1.A (m-anthropic-proxy) ship (99e1fb5 archived
      2026-05-18)
- [x] Phase 1.B (m-user-runtime-schema) ship in flight (C4
      4421819 on m-user-runtime-schema branch, 待 merge with
      Phase 2)
- [x] P3 cold start: docker run --rm avg 175-181ms, p99 211ms
      (spike-p3-p4.md)
- [x] P3.5 exec latency: docker exec avg 60-61ms, p99 74ms (3x
      faster than docker run)
- [x] P4 node-pty + docker exec -it: echo / resize / ANSI color
      全双 tty 透传 (perfect pass)

## 实现 — image + lifecycle

- [x] `docker/Dockerfile.ccanywhere-user` (C2): base `node:20-
      alpine` + iptables + shadow + bash + curl + **npm install
      -g @anthropic-ai/claude-code** (D7 第二次修订: vendor via
      npm, 撤回 mount — host macOS Mach-O 跟 Linux ABI 不兼容)
- [x] `docker/entrypoint.sh` (C2): hosts override + iptables
      REJECT api.anthropic.com (best-effort, NET_ADMIN required)
      + sleep infinity 待命. per-user account 不建 (留 C4 user-
      sync runtime mutation)
- [x] `scripts/build-container-image.sh` (C2): docker build + tag
      helper (ccanywhere/user-runtime:latest, image 663MB)
- [x] `scripts/container-manual-verify.sh` (C2): build + run +
      hosts override / anthropic blocked / github ACCEPT / claude
      --version 全验. PASS on claude 2.1.143 (image npm-installed
      Linux 版)
- [x] `src/container/exec.ts` (C3): 共享 ExecImpl interface +
      defaultExec (promisify(execFile) wrapper, 统一返 ExecResult
      不抛非 0)
- [x] `src/container/shared-manager.ts` (C3): SharedContainerManager
      ensureRunning (idempotent: absent→run, exited→start, running
      →noop) / stop (No such container 视为 success) / healthCheck
      (inspect + exec true 双层判)
- [x] `src/container/docker-detect.ts` (C3): DockerDetector.detect
      (docker info) + startMonitoring (周期 + flip-on-change
      callback) + stopMonitoring; 不做 dry-run container 启动
      (docker info 足够; dry-run alpine 拉去 keychain 复杂, 留
      C5 实际 spawn 时验)
- [x] `src/container/user-sync.ts` (C4): ContainerUserSync lazy
      ensureUser (idempotent useradd + chmod 0700 home; cache hit
      bypass docker exec). deterministic uidOf sha256 in
      [1000, 65000) range. 不做 active userdel (留 dormant 跨
      container restart 自然清, D4 acceptable cost)

## 实现 — spawn 分支

- [x] `src/session/manager-types.ts` (C4): SpawnOptions 加
      `runtime` (host/shared-container, optional) + `container`
      (name + unixUser, optional but required when runtime=shared)
- [x] `src/session/spawn-command.ts` (C4 新): buildSpawnCommand
      纯函数 — host 返 identity, shared-container 包成
      `docker exec -it -u <user> -e ... <ctn> <cmd> ...args`
      并把 user env 通过 `-e KEY=VAL` 注入 (不让 docker CLI
      proc env 看到). 拆出避免 manager.ts 超 300 行 lint cap
- [x] `src/session/manager.ts` (C4): spawn() 调 buildSpawnCommand
      路由; 既有 host 路径 0 改动 (零回归)
- [x] sessions.ts + sessions-resume.ts call site (C5): spawn 前调
      buildSessionRuntimeOverlay → 注入 ANTHROPIC_BASE_URL +
      ANTHROPIC_AUTH_TOKEN + CLAUDE_CONFIG_DIR + DISABLE_AUTOUPDATER
      + DISABLE_TELEMETRY when 走 shared-container 路径
- [x] `src/server/routes/session-runtime.ts` (C5 新): buildSession
      RuntimeOverlay (host vs shared dispatch) + buildThemeEnv
      (移自 sessions.ts/sessions-resume.ts 共享)
- [x] `src/cli/serve-isolation.ts` (C5): D5 解锁 sharedContainerReady
      opt (默认 false 保 Phase 1.B 行为); IsolationResolution 加
      perUserRuntime map; D6 docker availability detection 留 C6
      (跟 serve.ts wire 一起做)
- [x] BuildServerOptions (C5): 加 perUserRuntime + containerDeps
      字段, 透传给 registerSessionRoutes + registerSessionResume
      Routes options

## 实现 — workspace 隔离

- [ ] shared container `-v <host workspace>/<user>:/home/<user>/
      workspace`: per-user workspace mount
- [ ] /home/<user> mode 0700: filesystem 跨 user 隔离 (best-effort
      unix perm, 跟 m-user-runtime-schema D1 决策一致)
- [ ] CLAUDE_CONFIG_DIR /home/<user>/.claude per session 隔离 cc
      state

## 实现 — CLI + 部署

- [x] `src/cli/container-cmd.ts` (C6): `ccanywhere container
      {build,ensure,stop,status}` 子命令; build 转指 script;
      ensure/stop 调 SharedContainerManager; status 查 docker +
      容器健康
- [x] `src/cli.ts` (C6): 注册 container 子命令 + HELP (cap 紧:
      HELP 一行 with `<sub>` placeholder 避免超 300 行)
- [x] `src/cli/container-init.ts` (C6 新): initContainerStack
      封装 docker detect + ensureRunning + TokenIssuer +
      ContainerUserSync init; 返 ContainerInitResult { ready,
      deps, shutdown }
- [x] `src/cli/serve.ts` (C6): 调 initContainerStack 拿
      sharedContainerReady + containerDeps; 传 buildServer;
      shutdown 调 containerInit.shutdown()

## 测试

- [x] `src/container/shared-manager.test.ts` (C3, 13): ensureRunning
      4 case (absent/run / running/noop / exited/start / fail throw)
      + 2 capAdd/extraArgs + stop 3 + healthCheck 4
- [x] `src/container/docker-detect.test.ts` (C3, 8): detect 4
      (available / unavailable / fallback reason source) +
      startMonitoring 4 (first fire / flip-only / stop clear /
      idempotent)
- [x] `src/container/user-sync.test.ts` (C4, 8): uidOf
      determinism / range / 不同 username 不撞 + ensureUser
      noop-on-exist / useradd+chmod 路径 / cache 路径 / useradd
      错 / chmod 错
- [x] `src/session/manager.spawn-container.test.ts` (C4, 7):
      host 路径 2 (omitted/host) + shared-container 5 (missing
      container throw / docker exec 包装 / env→-e / no env /
      args 顺序)
- [ ] `src/cli/serve-isolation.test.ts` 加: D5 shared-container
      Phase 2 ready 后通过 + D6 docker detection 行为
- [ ] e2e: 真起 shared container + spawn user session + claude
      --print 走 proxy + clean up (跟 scripts/proxy-manual-verify
      .sh 同款模式; 新 scripts/container-manual-verify.sh)

## docs

- [x] `docs/deployment-container.md` (C6 新, 144 行): 容器化部署
      + image build + 启用步骤 + session 行为 + CLI + 限制 +
      排错 + follow-up
- [x] `docs/deployment-isolation.md` (C6 改): §7 Phase 2 预告改
      为 Phase 2 完工说明 + reserved follow-up
- [x] `docs/deployment.md` (C6 改): §10 Phase 2 引用

## archive

- [x] proposal status: planned → archived (C6)
- [x] mv openspec/changes/m-user-shared-container →
      openspec/archive/2026-05-18-m-user-shared-container (C6)

## commit 拆分

- [x] C1 d1c0651: spike + proposal + tasks (planned)
- [x] (in-flight) 71f847e: proposal D5/D7 review iteration
- [x] C2 7c774c1: Dockerfile + entrypoint + build script + image
      manual-verify
- [x] C3 c87b3a8: shared-manager + docker-detect + 测试
- [x] C4 31d70c7: user-sync + session manager spawn 分支 + 测试
- [x] C5 6197eca: serve-isolation D5 解锁 + spawn dispatch +
      session-runtime helper
- [x] C6 本笔: container-init wire + container CLI 子命令 +
      docs + archive

7 commit, ~3500 LOC src + ~1100 LOC test + ~500 LOC docs +
Dockerfile + scripts. 比 Phase 1.A (2700 LOC) 大 1.3x. 比初版
estimate (1500-2000 src) 偏高 — spike 后 verify wire 复杂度比预
想多 (IsolationResolution refactor + perUserRuntime map + container
-init 拆分等).

## BACKLOG follow-up (proposal "后续 follow-up" 段记录, 不重复)

- m-user-isolated-container (reserved long-term)
- m-runtime-degraded-ui-banner (Phase 2 子项独立 ship)
- m-runtime-status-endpoint (Phase 2 子项独立 ship)
- m-shared-container-max-users (BACKLOG long-term)
- m-proxy-quota-sync (Phase 2 + proxy follow-up)
- m-windows-support (BACKLOG long-term)
- m-container-apikey-helper (Phase 2 子项)
