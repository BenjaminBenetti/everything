#!/usr/bin/env bash
# Build one container from its owning workspace, using the repository as build context.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=${1:?Provide the workspace path relative to the repository root}
image=${2:?Provide the image tag}
build_args=()
if [ -n "${CODEX_PROXY_CERT:-}" ]; then
  build_args+=(--secret "id=proxy_ca,src=$CODEX_PROXY_CERT")
fi
docker build "${build_args[@]}" -f "$container/container/Dockerfile" -t "$image" .
