#!/usr/bin/env bash
# Run the Bruno API collection against the local stack, forwarding the ingress unless cluster:forward is running.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

trap stop_forward EXIT
start_forward
wait_until_serving
pnpm --filter @everything/api-tests test:api
