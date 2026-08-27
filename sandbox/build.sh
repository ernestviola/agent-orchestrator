#!/usr/bin/env bash
# Build the sub-agent + egress-proxy images the provisioning layer expects.
# Run from the repo root (or anywhere — paths are resolved relative to this script).
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SANDBOX_IMAGE="${SANDBOX_IMAGE:-orq-sandbox:dev}"
PROXY_IMAGE="${PROXY_IMAGE:-orq-proxy:dev}"

echo "Building ${SANDBOX_IMAGE} ..."
docker build -t "${SANDBOX_IMAGE}" -f "${SANDBOX_DIR}/Dockerfile" "${SANDBOX_DIR}"

echo "Building ${PROXY_IMAGE} ..."
docker build -t "${PROXY_IMAGE}" -f "${SANDBOX_DIR}/Dockerfile.proxy" "${SANDBOX_DIR}"

echo "Done: ${SANDBOX_IMAGE}, ${PROXY_IMAGE}"
