#!/bin/bash
#
# Shared container entrypoint — sleeps forever; user spawns dock in via
# `docker exec`. Container cc dials api.anthropic.com directly with the
# owner's CLAUDE_CODE_OAUTH_TOKEN env (injected at session-runtime).

set -euo pipefail

echo "[entrypoint] shared container starting"
echo "[entrypoint] init done; sleeping forever"
exec sleep infinity
