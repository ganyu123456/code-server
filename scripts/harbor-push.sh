#!/usr/bin/env bash
set -euo pipefail
HARBOR_URL="harbor.zkjgy.online"
HARBOR_USER="admin"
HARBOR_PASS="Harbor12345"
HARBOR_PROJECT="library"
IMAGE_NAME="code-server"
TAG="${TAG:-latest}"
FULL_IMAGE="${HARBOR_URL}/${HARBOR_PROJECT}/${IMAGE_NAME}:${TAG}"
echo "==> Building Docker image..."
docker build -f Dockerfile.codex -t "${FULL_IMAGE}" .
echo "==> Logging into Harbor..."
echo "${HARBOR_PASS}" | docker login "${HARBOR_URL}" -u "${HARBOR_USER}" --password-stdin
echo "==> Pushing to Harbor..."
docker push "${FULL_IMAGE}"
echo "==> Done: ${FULL_IMAGE}"
