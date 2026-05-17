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

- [ ] `docker/Dockerfile.ccanywhere-user`: base alpine/debian-slim +
      node + iptables + sh + useradd helpers (**claude binary mount,
      D7**)
- [ ] `docker/entrypoint.sh`: iptables init (**DROP api.anthropic
      .com, ACCEPT 其他**, D5) + sleep infinity 待命; 容器启动加
      `-v <config.claudeBin>:/usr/local/bin/claude:ro` mount host
      claude (D7)
- [ ] `scripts/build-container-image.sh`: docker build + tag
      (ccanywhere/user-runtime:<version>) helper
- [ ] `src/container/shared-manager.ts`: ensureRunning /
      stop / healthCheck (lifecycle methods)
- [ ] `src/container/docker-detect.ts`: docker info + dry-run
      container 启动验证, 30s 周期 health-check
- [ ] `src/container/user-sync.ts`: 在 running container 内
      useradd / userdel (跟随 ccanywhere user CLI)

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

- [ ] `src/container/shared-manager.test.ts`: lifecycle / health /
      重启 backoff
- [ ] `src/container/docker-detect.test.ts`: docker 可达 / 不可达
      / 中途挂 (mock docker CLI)
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
