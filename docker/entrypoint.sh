#!/bin/bash
#
# Shared container entrypoint (Phase 2).
#
# D10 amendment (anthropic 2026-02 OAuth policy reversal): the original
# entrypoint enforced anthropic-via-proxy by /etc/hosts override +
# iptables REJECT. Both layers are removed — anthropic rejects
# third-party OAuth Bearer proxies, so container cc must dial
# api.anthropic.com directly with the owner's CLAUDE_CODE_OAUTH_TOKEN
# env (session-runtime overlay D10 inject).
#
# proxy module + its 8082 endpoint remain inside ccanywhere main as
# a backup path (re-enable when anthropic policy changes or owner
# switches to Console API key). user spawn wiring no longer points
# at it.

set -euo pipefail

echo "[entrypoint] shared container starting (D10: direct anthropic)"
echo "[entrypoint] init done; sleeping forever (long-running shared container)"
exec sleep infinity
