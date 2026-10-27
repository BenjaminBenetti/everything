#!/usr/bin/env bash
# Serve the development ingress until interrupted: the application at http://localhost:8080, the
# stack's public origin, the artifact host at http://localhost:8081, and the public apps host at
# http://127.0.0.1:8082, a hostname of its own because browsers share a hostname's cookies across ports.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

exec kubectl --context "$context" -n "$ingress_namespace" port-forward --address 127.0.0.1 \
  "service/$ingress_service" "$local_port:80" \
  "$artifact_local_port:$artifact_local_port" \
  "$public_apps_local_port:$public_apps_local_port"
