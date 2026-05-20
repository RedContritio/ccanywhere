# Deployment — user shared container (, Phase 2)

Phase 2 user runtime isolation：admin 配 `users.<name>.runtime:
'shared-container'` 时，session spawn 通过 `docker exec` 进入一个
长跑 shared container 里跑 claude（不再走 owner 身份）。anthropic
流量经 ccanywhere-anthropic-proxy 隔离（Phase 1.A）。

主部署文档见 [deployment.md](./deployment.md)；代理见
[deployment-proxy.md](./deployment-proxy.md)；schema/启动行为见
[deployment-isolation.md](./deployment-isolation.md)。

## 1. 前置

- macOS Docker Desktop 运行中
- 已 ship Phase 1.A （`ccanywhere proxy serve`
  独立 LaunchAgent listen :62276）
- 已 ship Phase 1.B （schema 含
  `isolationPolicy` + `users.<name>.runtime`）

## 2. build user runtime image

```bash
./scripts/build-container-image.sh
# image: ccanywhere/user-runtime:latest (~663MB)
# 含: node:20-alpine + iptables + shadow + npm install -g
#     @anthropic-ai/claude-code (Linux 版 claude, D7)
```

每次 claude release 想升级时 rebuild + restart shared container：

```bash
./scripts/build-container-image.sh
ccanywhere container stop
ccanywhere container ensure
```

## 3. 验证 image

```bash
./scripts/container-manual-verify.sh
# 启 container 跑 NET_ADMIN + iptables + claude --version
# PASS 表示 image 健康
```

## 4. 启用 user 容器化

config 设非 owner user `runtime: 'shared-container'`：

```json
{
  "users": {
    "alice": { "runtime": "shared-container" },
    "bob": { "runtime": "shared-container" }
  }
}
```

restart ccanywhere main server：

```bash
launchctl kickstart -k gui/$(id -u)/com.<you>.ccanywhere
sleep 3 && curl -sf http://127.0.0.1:62275/healthz
# {"ok":true,"isolation":{"mode":"strict","ready":true}}
```

启动 banner 会显示 shared container running：

```
[server] isolation: strict mode, 1 user(s) on host
[server] shared container running: ccanywhere-shared-62275
```

## 5. session 行为 ( D10 反转后)

alice/bob 通过 web 起 session:
- ccanywhere ContainerUserSync.ensureUser 在 shared container 内
  `useradd alice` (lazy, per user 首 session 触发) + chmod 0700
  `/home/alice` + mkdir `/var/lib/ccanywhere/user-claude/alice`
  chown 0700 + cp baked `CLAUDE.md` + `settings.json` 进去 (D6
  defense in depth: LLM soft norm + cc permission deny rules)
- spawn `docker exec -it -u alice -e CLAUDE_CONFIG_DIR=/var/lib/
  ccanywhere/user-claude/alice -e DISABLE_AUTOUPDATER=1 -e
  DISABLE_TELEMETRY=1 -e CLAUDE_CODE_OAUTH_TOKEN=<owner sk-ant-oat>
  -w <translated cwd> ccanywhere-shared-<port> claude --session-id
  <uuid>`
- claude 在容器内跑, **直连** `api.anthropic.com` (entrypoint 不
  再 hosts override / iptables REJECT — D10 撤回 anthropic 拦截).
  anthropic 看到的请求是 cc binary first-party + 容器内 setup-token
  匹配 device fingerprint → 接受 OAuth subscription path, 计费走
  owner Pro/Max plan.

**owner OAuth token 一次性容器内 setup** (在 container 内跑 `claude
setup-token`, token 必须容器内 issued 才能容器内 use; host 跑出来
的 token 跨设备给容器用 anthropic 会 invalidate). 详 D10 amendment.

owner 路径 0 改动: owner session 仍直接本机 spawn claude 走 mac
Keychain → api.anthropic.com (D7 D8 决策).

## 6. CLI 子命令

```bash
ccanywhere container ensure    # 手动起 shared container (admin debug)
ccanywhere container stop      # 停 + 删
ccanywhere container status    # docker + 容器健康一行
ccanywhere container build     # hint → 用 scripts/build-container-image.sh
```

## 7. 限制 + 已知 trade-off

**单 shared container 故障域** (D8): 一 user crash → 全容器 die。
mitigation: docker `--restart unless-stopped` 自动 respawn。

**不可信 user 不要用 shared-container**: shared 模型 fs/process
隔离靠 unix perm 0700 + UID 分隔 (best-effort)，alice 仍能 `ps`
看 bob 的 claude 命令行。真正不可信场景需 `isolated-container`
runtime（schema 接受 enum 但 reserved，未实现）。

**~~iptables + /etc/hosts 双层防护~~ (D10 撤回)**: 早期 entrypoint
强制 anthropic 流量经 proxy 用 iptables REJECT + /etc/hosts override
两层. D10 反转后 anthropic 政策禁第三方 proxy 转 OAuth Bearer,
proxy 离开 user 流量路径, 容器直连 anthropic, 两层防护一起撤.

**claude binary 版本由 image 决定**：rebuild image 时 npm 拉
latest，跟 host 可能漂移。想 pin 改 Dockerfile：
`@anthropic-ai/claude-code@<version>`。

**workspace override + shared-container 不支持** (D9): non-owner
user 在 config 里加 `workspace` override + `runtime:
'shared-container'` → 启动 fatal。原因: override path 不在 host
workspace mount 内, container 看不到; cwd 翻译失败。fix 或者删
workspace override 或者改 runtime 为 host。完整支持留
BACKLOG `` follow-up。

## 8. 排错

container 起不来：
```bash
ccanywhere container status   # docker available? container running?
docker logs ccanywhere-shared-62275   # entrypoint stderr
```

healthz 显示 isolation 但 user session fail：
```bash
docker exec ccanywhere-shared-62275 ps aux   # 容器内 alice 进程?
docker exec -u alice ccanywhere-shared-62275 claude --version  # claude
```

代理 fail 但 anthropic 流量没被阻：
```bash
docker exec ccanywhere-shared-62275 grep api.anthropic /etc/hosts
docker exec ccanywhere-shared-62275 iptables -L OUTPUT
```

## 9. follow-up (reserved, 见 archive proposal)

- : per-user 独立容器, 给真不可信用户
- : web 顶条提示 user host mode
- : /api/internal/runtime-status admin
- : 限上限
- : proxy 账本 + UserStore.quota 双向 sync
- : 5min token 自动 rotation via
  apiKeyHelper（替代每 session 启动新 token）
