#!/bin/bash
#
# m-user-shared-container Phase 2: shared container entrypoint
#
# 两层防护强制 anthropic 流量经 ccanywhere-anthropic-proxy:
#   Layer 1: /etc/hosts override — api.anthropic.com → 127.0.0.1.
#            零 cap requirement。任何 DNS resolve 都解到 loopback,
#            127.0.0.1 容器内没监听 → connection refused。即便没
#            NET_ADMIN cap 也能基本工作。
#   Layer 2: iptables REJECT — IP-level 阻断 api.anthropic.com.
#            需要 --cap-add NET_ADMIN。如果 daemon 不给 cap, 跳过
#            (warn), Layer 1 仍护栏。
#
# 其他外部 API (github MCP / web_search / fetch_url / 等) 仍 ACCEPT
# (D5 修订)。代理 endpoint host.docker.internal:62276 不受任何阻
# 断 (loopback ACCEPT + 域名不在 block list)。

set -euo pipefail

echo "[entrypoint] m-user-shared-container shared container starting"

# Layer 1: hosts override (always works)
if ! grep -q "api.anthropic.com" /etc/hosts; then
  echo "127.0.0.1 api.anthropic.com" >> /etc/hosts
  echo "[entrypoint] /etc/hosts: api.anthropic.com → 127.0.0.1"
fi

# Layer 2: iptables (best-effort, requires NET_ADMIN)
if command -v iptables >/dev/null 2>&1 && iptables -L >/dev/null 2>&1; then
  iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  if iptables -I OUTPUT -d api.anthropic.com -j REJECT 2>/dev/null; then
    echo "[entrypoint] iptables: REJECT api.anthropic.com installed"
  else
    echo "[entrypoint] iptables REJECT failed (DNS resolution issue?); hosts-only mode"
  fi
else
  echo "[entrypoint] iptables not usable (need --cap-add NET_ADMIN); hosts-only mode"
fi

echo "[entrypoint] init done; sleeping forever (long-running shared container)"
exec sleep infinity
