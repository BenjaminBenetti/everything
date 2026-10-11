#!/usr/bin/env bash
# Run Bruno before and after pod replacement; API requests and assertions stay in the collection.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh
state_env=$(mktemp "$PWD/.local/bruno-restart-XXXXXX.bru")
cp testing/api/bruno/environments/Local.bru "$state_env"
trap 'stop_forward; rm -f "$state_env"' EXIT

# Run one phase's requests after authenticating, carrying state between phases in $state_env.
run_phase() {
  (cd testing/api/bruno && ../node_modules/.bin/bru run requests/02-authentication/03-authenticate-bruno.bru "restart/$1" --env-file "$state_env" --bail)
}

# The ingress controller is not restarted, so one forward lasts through the pod replacements.
start_forward
wait_until_serving
if [ "${1:-}" = --with-api ]; then bash deployment/script/test-api.sh; fi
run_phase before
restart_stack
wait_until_serving
run_phase after
