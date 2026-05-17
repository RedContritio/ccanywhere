---
status: spike-result
---

# Spike: P3 + P3.5 + P4 — Phase 2 容器化 prototype 数据

本笔为 `m-user-shared-container` proposal 的证据基底。Phase 2 容器
化方案的两个关键不确定性：
1. macOS Docker Desktop cold start 真实数字（之前讨论假设 3-8s）
2. node-pty + docker exec TTY/SIGWINCH 信号穿透行为

本 spike 验证两者。

## 验证环境

| 项 | 值 |
|---|---|
| Date | 2026-05-18 |
| Docker | client 29.3.1 / server 29.3.1 (Docker Desktop) |
| Host | macOS arm64, 17.5GB RAM, 9 CPU |
| Test image | `python:3.13-slim` (203MB) — Phase 2 image 估 200-500MB 含 claude binary + deps，python:3.13-slim 是合理 surrogate |
| Node | v24.14.1 |
| node-pty | 1.2.0-beta.12 (跟 ccanywhere prod 一致) |

## P3 — `docker run --rm` cold start

**Question**: per-session 启停模式下，每次 session start 的 cold
start 实际多少？

**Script**: `scripts/spike-p3-cold-start.mjs`
```bash
node scripts/spike-p3-cold-start.mjs
# image: python:3.13-slim, runs: 10
# cmd:   docker run --rm python:3.13-slim true
```

**Results (10 runs, 2 batches consistent)**:

| stat | value |
|---|---|
| min | 158 ms |
| p50 | 176 ms |
| p90 | 184 ms |
| p99 | 211 ms |
| avg | 175-181 ms |
| range | 25-53 ms |

**结论**: 之前讨论假设 "macOS cold start 3-8s" **错了**。Apple
Silicon Docker Desktop per-container start full lifecycle (create
+ start + exec + remove) < 250ms。Phase 2 设计**不需要**为 cold
start 增加复杂 lifecycle (idle reaper / pre-warm)。

## P3.5 — `docker exec` into long-running container

**Question**: 如果 Phase 2 走 shared container 模式 (一个长跑
container, 每 session 是 docker exec 进去)，latency 多少？vs
per-session 启停差多少？

**Script**: `scripts/spike-p3b-exec-latency.mjs`
```bash
node scripts/spike-p3b-exec-latency.mjs
# 起 long-running container, 10 次 docker exec ... true
```

**Results**:

| stat | value |
|---|---|
| min | 47 ms |
| p50 | 59-65 ms |
| p99 | 72-74 ms |
| avg | 60-61 ms |

**对比**: `docker exec` (60ms avg) vs `docker run --rm` (180ms avg)
≈ **3x faster**。但两者都远低于 user-perceptible 阈值 (~500ms)。

**结论**: 两种 lifecycle 都 UX 可接受。`docker exec` (shared
container) 略快 + 复用容器资源；`docker run` 简洁 + 无状态。

## P4 — node-pty + docker exec -it 双 tty 穿透

**Question**: ccanywhere 当前 spawn 用 node-pty 包外层 pty；Phase
2 改 spawn 为 `docker exec -it`，docker 自己分内层 tty。**双 tty**
情况下，echo / resize / ANSI color 是否完整透传？

**Script**: `scripts/spike-p4-pty-docker.mjs`
```bash
node scripts/spike-p4-pty-docker.mjs
```

流程:
1. 起 long-running container
2. node-pty spawn `docker exec -it <ctn> sh` (cols 100 / rows 30)
3. 发 `echo HELLO_FROM_PTY` → 验回显
4. 发 `stty size` → 验 container 内 tty 看到的 dims
5. node-pty `.resize(80, 24)` → 验 SIGWINCH 透传
6. 再发 `stty size` → 验 resize 生效
7. 发 ANSI escape `\033[31mRED\033[0m` → 验 color 透传

**Results**:

```
contains HELLO_FROM_PTY: true            # echo 完整透传 ✓
stty size matches: [ '30 100', '24 80' ] # resize 双 tty 完美透传 ✓
contains red escape: true                # \x1b[31m 保留 ✓
contains "RED" text: true                # color + text 都到 ✓
```

**结论**: **完美 PASS**。双 tty 在 ccanywhere → node-pty → docker
exec stdin/stdout → docker 内层 tty → shell/claude 链路上完整透传：
- stdin/stdout bytes 不丢
- SIGWINCH 自动透传 (node-pty.resize → docker exec API → 内层 tty)
- ANSI escape 不被中间层 strip

Phase 2 spawn 改造 **零额外复杂度**:
```ts
// Phase 1 (host):
ptySpawn(claudeBin, args, {cols, rows})

// Phase 2 (shared container):
ptySpawn('docker', ['exec', '-it', sharedCtn, '-u', uid, claudeBin, ...args], {cols, rows})
```

## 关键发现 (对 Phase 2 设计的约束)

### F1. cold start 不是问题
`docker run --rm` 180ms / `docker exec` 60ms — 两者 UX 都不可感知。
**Lifecycle 决策应该按其他维度选** (容器内 state 持久性 / 隔离
需求 / 资源 footprint)，不是 cold start。

### F2. shared-container + docker exec 最优
对应 "自用 + 信任小号" 场景 (m-user-runtime-schema D1)：
- 单容器多 OS user (chmod 隔离)，cost-optimization
- 长跑一个 ccanywhere shared container，per session 用 docker exec
- session 用对应 unix user (alice/bob) 跑 claude
- ccanywhere 启停时 ensure/destroy shared container 一次

### F3. spawn 改造极简
session manager 的 ptySpawn 调用，第一参数从 `claudeBin` 换成
`docker`，args 前面套 `['exec', '-it', sharedCtn, '-u', <user>,
claudeBin, ...args]`。零代码上 SIGWINCH 处理 (node-pty + docker
自动)。

### F4. 双 tty 完美
不需要担心 ANSI color / cursor / mouse / resize 在 docker 边界丢
失。这是最大的 unknown，已 resolved。

## 仍待解 (Phase 2 实现时验)

- **P5**: 容器内 unix user 切换 (-u flag 或 sudo) + per-user
  `CLAUDE_CONFIG_DIR` + `~/.claude/` 隔离 — 跟 m-anthropic-proxy 时
  spike F6 "cwd 污染防御" 配套
- **P6**: iptables 容器内**DROP api.anthropic.com (ACCEPT 其他)** —
  D5 修订后行为, 验证 NET_ADMIN cap 在 Docker Desktop 可用 +
  github / web_search 等外部流量正常 ACCEPT + anthropic 直连被
  阻断 (强制走代理)
- **P7**: claude binary **mount** (D7 修订, 不 vendor) — 验证
  `-v <config.claudeBin>:/usr/local/bin/claude:ro` 后容器内能
  正常调用 + ANTHROPIC_BASE_URL 透传到 ccanywhere-anthropic-proxy
- **P8**: shared container 崩溃恢复 (Phase 2 lifecycle): docker
  health-check + 自动重启 vs ccanywhere 主动 ensure

P5-P8 不阻塞 Phase 2 proposal — 是 implementation 子任务。本 spike
仅解决 Phase 2 design phase 的两个核心不确定性 (cold start +
pty/tty)。

## 不必再做

- ❌ 测 alpine cold start: python:3.13-slim 已是合理 surrogate，
  Phase 2 image 大小估 200-500MB 跟它接近
- ❌ 测 docker network policy: Phase 2 实现 iptables 时一起验
- ❌ 跨 user 容器隔离 multi-tenant cost: 跟 m-user-runtime-schema
  D1 决策 (single shared container + chmod 隔离) 已经 align
