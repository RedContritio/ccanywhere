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
- [ ] `src/container/user-sync.ts`: 在 running container 内
      useradd / userdel (跟随 ccanywhere user CLI) — C4

## 实现 — spawn 分支

- [ ] `src/session/manager.ts`: SpawnOptions 加 `runtime` 字段;
      spawn() 按 runtime 分支:
  - host: 既有 ptySpawn (零改动)
  - shared-container: ptySpawn('docker', ['exec', '-it',
    SHARED_CTN, '-u', userUid, command, ...args], {...})
- [ ] session 流程: spawn 前 env 注入 ANTHROPIC_BASE_URL +
      ANTHROPIC_AUTH_TOKEN (proxy issue) + CLAUDE_CONFIG_DIR=
      /home/<user>/.claude + DISABLE_AUTOUPDATER=1 +
      DISABLE_TELEMETRY=1
- [ ] `src/cli/serve-isolation.ts`: D5 解锁 'shared-container'
      (Phase 2 ready) + D6 加 docker availability detection
      (strict 模式 docker 不可达 fatal; fallback 模式 override
      host + warn)

## 实现 — workspace 隔离

- [ ] shared container `-v <host workspace>/<user>:/home/<user>/
      workspace`: per-user workspace mount
- [ ] /home/<user> mode 0700: filesystem 跨 user 隔离 (best-effort
      unix perm, 跟 m-user-runtime-schema D1 决策一致)
- [ ] CLAUDE_CONFIG_DIR /home/<user>/.claude per session 隔离 cc
      state

## 实现 — CLI + 部署

- [ ] `src/cli/container-cmd.ts`: `ccanywhere container {build,
      ensure,stop,status}` 子命令
- [ ] `src/cli.ts`: 注册 container 子命令 + HELP
- [ ] `src/cli/serve.ts`: 启动时 ensureRunning shared container;
      graceful shutdown 时 stop (但 docker --restart unless-
      stopped 让 docker daemon 自己保持持久存活也是 option)

## 测试

- [x] `src/container/shared-manager.test.ts` (C3, 13): ensureRunning
      4 case (absent/run / running/noop / exited/start / fail throw)
      + 2 capAdd/extraArgs + stop 3 + healthCheck 4
- [x] `src/container/docker-detect.test.ts` (C3, 8): detect 4
      (available / unavailable / fallback reason source) +
      startMonitoring 4 (first fire / flip-only / stop clear /
      idempotent)
- [ ] `src/container/user-sync.test.ts`: useradd / userdel +
      container 不可达时降级
- [ ] `src/session/manager.spawn-container.test.ts`: runtime
      分支 + env 注入 + host 路径零回归
- [ ] `src/cli/serve-isolation.test.ts` 加: D5 shared-container
      Phase 2 ready 后通过 + D6 docker detection 行为
- [ ] e2e: 真起 shared container + spawn user session + claude
      --print 走 proxy + clean up (跟 scripts/proxy-manual-verify
      .sh 同款模式; 新 scripts/container-manual-verify.sh)

## docs

- [ ] `docs/deployment-container.md` (新): 容器化部署 + image
      build + iptables 校验 + 升级流程
- [ ] `docs/deployment-isolation.md` (改): §6 升级步骤改 (Phase 2
      ship 后 shared-container 真生效, 不再 fatal); §7 Phase 2
      预告改为 Phase 2 完工说明
- [ ] `docs/deployment.md` (改): §9 引用更新

## archive

- [ ] proposal status: planned → in-flight → archived
- [ ] mv openspec/changes/m-user-shared-container →
      openspec/archive/<date>-m-user-shared-container

## commit 拆分 (估算, 实现时按需调整)

- [ ] C1 本笔: spike + proposal + tasks (planned)
- [ ] C2: Dockerfile + entrypoint + build script + image
      manual-verify
- [ ] C3: shared-manager + docker-detect + 测试
- [ ] C4: user-sync + session manager spawn 分支 + env 注入 + 测试
- [ ] C5: serve-isolation D5/D6 解锁 + iptables 验证 + CLI 子命令
- [ ] C6: docs + e2e manual-verify script + archive

5-6 commit, 估 ~1500-2000 LOC src + ~700 LOC test + 200 LOC docs +
Dockerfile + scripts. 比 Phase 1.A 大 1.5-2x.

## BACKLOG follow-up (proposal "后续 follow-up" 段记录, 不重复)

- m-user-isolated-container (reserved long-term)
- m-runtime-degraded-ui-banner (Phase 2 子项独立 ship)
- m-runtime-status-endpoint (Phase 2 子项独立 ship)
- m-shared-container-max-users (BACKLOG long-term)
- m-proxy-quota-sync (Phase 2 + proxy follow-up)
- m-windows-support (BACKLOG long-term)
- m-container-apikey-helper (Phase 2 子项)
