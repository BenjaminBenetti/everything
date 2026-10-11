#!/usr/bin/env bash
# Serve the development ingress at http://localhost:8080, the stack's public origin, until interrupted.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

exec kubectl --context "$context" -n "$ingress_namespace" port-forward --address 127.0.0.1 \
  "service/$ingress_service" "$local_port:80"
