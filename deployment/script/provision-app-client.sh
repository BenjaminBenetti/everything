#!/usr/bin/env bash
# Provision the app management identity in an existing local realm without replacing users or data.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

workload=$(stack_workload_with_environment EVERYTHING_APP_PROVISIONER_CLIENT_SECRET --values "$dev_values")
if [ -z "$workload" ] || [[ "$workload" == *$'\n'* ]]; then
  echo "Expected one Keycloak workload in the rendered chart." >&2
  exit 1
fi
kubectl --context "$context" -n "$namespace" exec "$workload" -- /opt/keycloak/bin/provision-app-client.sh
