# Spike Results: m-host-credentials-share P9 / P10

## P9 Step A: userClaudeRoot mount + per-user chmod/chown 链路

**目的**: 验 D3/D4 设计 — 单 mount 根目录 + per-user 子目录
mkdir/chown/chmod 0700 在 docker 容器内的真实行为, 不涉及
proxy/credentials/真 cc 调用 (留 Step B).

**环境**: macOS 25.4.0 (Darwin), Docker Desktop Server 29.3.1,
image `ccanywhere/user-runtime:latest` (m-user-shared-container
ship 时 build).

**步骤**:
1. tmp host dir = `mktemp -d /tmp/spike-p9-XXX`, mode 0755
2. `docker run -d --cap-add NET_ADMIN -v $TMP:/var/lib/
   ccanywhere/user-claude:rw ccanywhere/user-runtime:latest`
3. 容器内 `useradd -u 1001 -m e2e` + `useradd -u 1002 -m miomio`
4. `mkdir + chown <uid>:<gid> + chmod 0700` per-user 子目录
5. 验三组:
   a. e2e 自己目录可 read/write (own dir 0700 owned by self)
   b. e2e 跨 user 试 read/write miomio 目录 (应 denied)
   c. mount 双向同步 (容器内写 host 看到)

**结果**:

| 测试 | 期望 | 实际 |
|---|---|---|
| entrypoint 跑通 (hosts override + iptables) | OK | ✓ OK |
| mount 挂上 (容器内 ls 看到 `/var/lib/ccanywhere/user-claude`) | OK mode 0755 | ✓ `drwxr-xr-x root:root` |
| useradd e2e/miomio | OK | ✓ |
| per-user 子目录 mode 0700 owner=user | mkdir/chown/chmod 成功 | ✓ `drwx------ e2e:e2e`, `drwx------ miomio:miomio` |
| **e2e 写自己目录** | success | ✓ exit=0, host 看到 file |
| **e2e 写 miomio 目录 (cross-user attack)** | **denied** | **✗ success! attacker.txt 真创建** |
| mount 双向同步 | host 看到 container 写的 file | ✓ |
| miomio 目录在 e2e 操作后仍空 (host view) | 空 | host 看到 attacker.txt (跟上一行同) |

**Control 验证 (区分 mount 问题 vs container 全局 problem)**:

| 测试 | 结果 |
|---|---|
| e2e 读 `/etc/shadow` (root:root 0600, container overlay fs) | ✓ denied |
| e2e 写 `/tmp/test-perm/` (miomio:miomio 0700, container overlay fs) | ✓ denied (perm enforce 正常) |
| e2e 写 `/var/lib/ccanywhere/user-claude/miomio/` (miomio:miomio 0700, **bind mount**) | ✗ success (perm 不 enforce) |

**结论**:

1. **macOS docker desktop 的 bind mount (gRPC FUSE/virtiofs)
   不 enforce inode permission** — container 内 stat 显示
   mode + owner 元数据正确, 但 read/write 不按 inode perm
   过滤. 任何 container user 能 read/write 任何 mount 子
   目录.
2. **container overlay fs (非 mount) permission enforce 正常**
   — chmod 0700 在 container 内自己的 fs 上真生效.
3. **结论对架构影响**: D4 "per-user 子目录 0700 隔离 inter-
   user" 在 macOS 部署下不真 enforce. 走 A 方案 — D2 trust
   model 接受 macOS 不 enforce, 仍保留 chmod/chown 步骤
   (linux 部署 enforce, 部分 social-engineering 防御, 一次
   docker exec ~10ms 成本小).

**架构决策**: proposal D4 改写, 明示 macOS limitation. 形式
化保证 "user 间 jsonl/settings/CLAUDE.md 互不可读" 条目保留
但加 ⚠ macOS docker desktop 不 enforce 标注. "不做" 段加
"macOS docker desktop 下真 inter-user fs 隔离" (loopback ext4
/ qcow / VM, 留 `m-user-fs-isolation-macos` reserved).

**未跑 (留 Step B)**:
- host.docker.internal:62276 容器内可达性 (proxy 没装, 62276
  没 listen — 等鉴权部分 work 再验)
- proxy 转发 cc 流量 (要 owner credentials)
- `claude --print "say hi"` 真返响应 (要 proxy + credentials)
- jsonl 落 host path 真验 (要 cc 真跑)
- owner `~/.claude/projects/` 没被污染验 (要 cc 真跑)

## P9 Step B: cc → proxy 真流量 (pending)

依赖:
- `~/.config/ccanywhere/anthropic-credentials.json` 存在 +
  含 `oauthToken` (D8 amendment 路径) 或 `apiKey`
- `com.<owner>.ccanywhere-proxy.plist` LaunchAgent 装好,
  proxy 真 listen `127.0.0.1:62276`
- baked CLAUDE.md / settings.json 存在 (C5 commit 才做, 或
  Step B 前临时创个 fake file 验 layout)

跑序列:
1. `docker exec -u 1001 -e CLAUDE_CONFIG_DIR=/var/lib/
   ccanywhere/user-claude/e2e -e ANTHROPIC_BASE_URL=http://
   host.docker.internal:62276 -e ANTHROPIC_AUTH_TOKEN=
   <bearer> <ctn> claude --print "say hi"`
2. 验 anthropic 真返响应
3. 验 jsonl 落 host `<tmp>/e2e/projects/...`
4. 验 owner `~/.claude/projects/` 没新文件
5. 验 host.docker.internal:62276 真可达 (容器内 curl)

失败回退:
- host.docker.internal 不通 → bind proxy 到 docker bridge IP
  (`0.0.0.0:62276` 或 docker0 gateway), 改 schema default
- bearer issuing 失败 → audit proxy token 路径

## P10: permission deny pattern (pending, 依赖 Step B 跑通)

baked candidate deny rules:
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

跑 user prompt 试 read environ / cat /proc, 调 rule 到主流
attack vector 防住. 落已知 bypass (defense in depth 非
enforcement, 显式标注边界).

**Step B + P10 触发条件**: 鉴权链路 (LaunchAgent + 
credentials) 就绪后跑.

## ensureUser baked-file refresh fix (P10 实施后发现, 2026-05-20)

P10 ship 后 e2e per-user dir 仍是旧版 baked files (CLAUDE.md 1508
bytes / 7 deny rules), 而 image baked 是新版 (2826 / 21 rules).
Root cause: ContainerUserSync.ensureUser cache.has(username) early
return 防 re-cp, image rebuild + ship 新 baked files 不 propagate
到已存在 user. Fix: ensureUser cache-hit + id-u-success 两条 early-
return 路径加 refreshBakedFiles 调用 (cp + chown idempotent, ~30ms
per spawn). 用户账户 setup (useradd / chmod /home / mkdir per-user
dir) 仍 cached, 只 baked files 每 spawn refresh. test 加 'cache hit
still refreshes baked files' 验. 修后 e2e session 下次 spawn 自动
拉 21 deny rules + 2826 byte CLAUDE.md.
