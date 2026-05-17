#!/bin/bash
#
# m-user-shared-container: build the ccanywhere user runtime image.
#
# 用法:
#   ./scripts/build-container-image.sh                # 默认 tag latest
#   CCANYWHERE_IMAGE_TAG=v0.6 ./scripts/build-container-image.sh
#
# 跑前提:
#   docker daemon ready (Docker Desktop 启动)
#   ~/.docker/config.json keychain 可用 OR DOCKER_CONFIG 跳过

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="${CCANYWHERE_IMAGE_NAME:-ccanywhere/user-runtime}"
IMAGE_TAG="${CCANYWHERE_IMAGE_TAG:-latest}"

cd "$REPO_ROOT/docker"
docker build -f Dockerfile.ccanywhere-user -t "${IMAGE_NAME}:${IMAGE_TAG}" .

echo ""
echo "built: ${IMAGE_NAME}:${IMAGE_TAG}"
docker images "${IMAGE_NAME}" --format '{{.Repository}}:{{.Tag}}\t{{.Size}}'
