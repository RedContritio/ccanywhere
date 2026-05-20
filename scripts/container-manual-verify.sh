#!/bin/bash
#
# Shared container manual verify — Phase 2 image 健康检查.
#
# 跑流程:
#   1. build image (跑 build-container-image.sh)
#   2. 起 long-running container (含 NET_ADMIN cap + claude mount)
#   3. 验 /etc/hosts override 生效 (api.anthropic.com → 127.0.0.1)
#   4. 验 anthropic 直连被阻断 (curl https://api.anthropic.com fail)
#   5. 验 github 等其他 API 仍 ACCEPT (curl https://api.github.com OK)
#   6. 验 claude binary mount 进容器 OK (claude --version 跑)
#   7. cleanup container

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${CCANYWHERE_IMAGE_NAME:-ccanywhere/user-runtime}:${CCANYWHERE_IMAGE_TAG:-latest}"
CTN="ccanywhere-verify-$$"

# D7 修订 (第二次): claude binary 通过 `npm install -g` 在 image
# build 时装入. 不再 mount host claude (host macOS Mach-O 跟
# Linux container 不兼容).

cleanup() {
  docker rm -f "$CTN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. build
echo "[1/7] building image..."
"$REPO_ROOT/scripts/build-container-image.sh"

# 2. run
echo "[2/7] starting container with NET_ADMIN..."
docker run -d --name "$CTN" \
  --cap-add NET_ADMIN \
  "$IMAGE"
sleep 1
docker logs "$CTN" | head -10

# 3. hosts override
echo "[3/7] verifying /etc/hosts override..."
hosts_line=$(docker exec "$CTN" grep api.anthropic.com /etc/hosts || true)
if [[ "$hosts_line" != *"127.0.0.1"* ]]; then
  echo "FAIL: hosts override missing: '$hosts_line'" >&2
  exit 2
fi
echo "  OK: $hosts_line"

# 4. anthropic 直连被阻断
echo "[4/7] verifying api.anthropic.com blocked..."
if docker exec "$CTN" curl -s -m 3 -o /dev/null -w '%{http_code}' https://api.anthropic.com/ 2>/dev/null | grep -qE '^[2-5]'; then
  echo "FAIL: api.anthropic.com still reachable!" >&2
  exit 2
fi
echo "  OK: connection refused / timeout"

# 5. github 仍可达
echo "[5/7] verifying api.github.com still ACCEPT..."
gh_code=$(docker exec "$CTN" curl -s -m 5 -o /dev/null -w '%{http_code}' https://api.github.com/ || echo "000")
if [[ "$gh_code" != "200" ]]; then
  echo "FAIL: api.github.com unreachable (code $gh_code); D5 over-blocking?" >&2
  exit 2
fi
echo "  OK: HTTP 200"

# 6. claude binary 调用
echo "[6/7] verifying claude binary (vendored via npm, D7)..."
cc_ver=$(docker exec "$CTN" claude --version 2>&1 | head -1)
echo "  claude --version: $cc_ver"
if [[ -z "$cc_ver" ]]; then
  echo "FAIL: claude --version returned empty" >&2
  exit 2
fi

# 7. cleanup handled by trap
echo "[7/7] cleanup on exit"

echo ""
echo "PASS — image $IMAGE verified"
