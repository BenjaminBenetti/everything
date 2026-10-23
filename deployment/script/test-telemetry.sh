#!/usr/bin/env bash
# Test Everything's telemetry against a disposable OpenObserve container run as the chart runs it:
# its pinned image, every setting the chart renders, its CPU and memory limits, a non-root user, and a
# read-only root filesystem. Checks that the image is published for amd64 and arm64, runs the
# export, query API, owner isolation, restart, and retention tests, and with --browser the Telemetry
# page in Chromium against the same storage. Reports the container's peak memory. Never touches a
# cluster; the container and its data are removed afterward.
#
#   bash deployment/script/test-telemetry.sh [--browser]
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

browser=false
for argument in "$@"; do
  case $argument in
    --browser) browser=true ;;
    *) echo "Usage: $0 [--browser]" >&2; exit 2 ;;
  esac
done

work=$(mktemp -d)
name="everything-telemetry-test-$$"
gateway_pid=
sampler_pid=
cleanup() {
  if [ -n "$gateway_pid" ]; then kill "$gateway_pid" 2> /dev/null || true; wait "$gateway_pid" 2> /dev/null || true; fi
  if [ -n "$sampler_pid" ]; then kill "$sampler_pid" 2> /dev/null || true; fi
  docker rm -f "$name" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# The openobserve service as the chart renders it: image, literal settings, limits, and retention.
render_stack --values "$dev_values" > "$work/chart.yaml"
node --input-type=module - "$work/chart.yaml" "$work" << 'EOF'
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(new URL("services/everything/package.json", `file://${process.cwd()}/`));
const { parseAllDocuments } = require("yaml");
const [chart, work] = process.argv.slice(2);
const workload = parseAllDocuments(readFileSync(chart, "utf8"))
  .map((document) => document.toJS())
  .find((document) => document?.kind === "StatefulSet" && document.metadata.name === "openobserve");
if (!workload) throw new Error("The chart renders no openobserve StatefulSet");
const container = workload.spec.template.spec.containers[0];
const environment = container.env
  .filter((variable) => variable.value !== undefined)
  .map((variable) => `${variable.name}=${variable.value}`);
writeFileSync(`${work}/environment`, environment.join("\n") + "\n");
writeFileSync(`${work}/image`, container.image);
writeFileSync(`${work}/memory`, container.resources.limits.memory);
writeFileSync(`${work}/cpus`, String(container.resources.limits.cpu));
writeFileSync(`${work}/retention`, environment.find((entry) => entry.startsWith("ZO_COMPACT_DATA_RETENTION_DAYS=")).split("=")[1]);
EOF
image=$(cat "$work/image")
memory=$(cat "$work/memory")
retention=$(cat "$work/retention")

# Public registries throttle shared CI addresses, so pulls are retried with a pause.
retry() {
  local attempt
  for attempt in 1 2 3 4; do
    if "$@"; then return 0; fi
    if [ "$attempt" = 4 ]; then return 1; fi
    echo "Retrying in $((attempt * 20)) seconds: $*" >&2
    sleep $((attempt * 20))
  done
}

# The installers support amd64 and arm64 nodes, so the pinned image must exist for both.
manifest=$(retry docker buildx imagetools inspect --raw "$image")
retry docker pull --quiet "$image" > /dev/null
for platform in amd64 arm64; do
  if ! grep -q "\"architecture\": *\"$platform\"" <<< "$manifest"; then
    echo "$image is not published for linux/$platform." >&2
    exit 1
  fi
done
echo "Image $image is published for linux/amd64 and linux/arm64."

# A fresh password like the chart's: the required prefix and 256 random bits.
password="Ot1-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$password" > "$work/password"
chmod 600 "$work/password"
mkdir -p "$work/data"
# A fixed host port, so the address survives the restart the tests make.
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
docker run -d --name "$name" --label everything.test=telemetry \
  --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --memory "${memory/Mi/m}" --cpus "$(cat "$work/cpus")" \
  --env-file "$work/environment" --env ZO_ROOT_USER_PASSWORD="$password" \
  -v "$work/data:/data" -p "127.0.0.1:$port:5080" "$image" > /dev/null
url="http://127.0.0.1:$port"
for attempt in {1..60}; do
  if curl -fs -o /dev/null "$url/healthz"; then break; fi
  if [ "$attempt" = 60 ]; then docker logs "$name" | tail -n 20 >&2; echo "OpenObserve did not start." >&2; exit 1; fi
  sleep 1
done
echo "OpenObserve is answering at $url with ${memory} of memory and $(cat "$work/cpus") CPU."

# Peak memory, sampled throughout the tests.
(
  peak=0
  while docker inspect "$name" > /dev/null 2>&1; do
    usage=$(docker stats --no-stream --format '{{.MemUsage}}' "$name" 2> /dev/null | cut -d/ -f1 | tr -d ' ')
    mib=$(awk -v value="$usage" 'BEGIN { n = value + 0; if (value ~ /GiB/) n *= 1024; else if (value ~ /KiB/) n /= 1024; printf "%d", n }')
    if [ "$mib" -gt "$peak" ]; then peak=$mib; echo "$peak" > "$work/peak"; fi
    sleep 1
  done
) &
sampler_pid=$!

export TELEMETRY_E2E_URL="$url"
export TELEMETRY_E2E_PASSWORD_FILE="$work/password"
export TELEMETRY_E2E_CONTAINER="$name"
export TELEMETRY_E2E_RETENTION_DAYS="$retention"
(cd services/everything && node --import tsx --test src/telemetry/test/openobserve.test.ts)

if $browser; then
  stream="browser_e2e_$$"
  (
    cd services/everything
    TELEMETRY_URL="$url" TELEMETRY_PASSWORD_FILE="$work/password" TELEMETRY_STREAM="$stream" \
      TELEMETRY_READ_SAMPLE_RATIO=1 TELEMETRY_E2E_GATEWAY_PORT=18182 TELEMETRY_E2E_ORIGIN=http://localhost:5183 \
      exec node --import tsx --import ./src/telemetry/bootstrap/instrumentation.ts src/telemetry/test/e2e-gateway.ts
  ) > "$work/gateway.log" 2>&1 &
  gateway_pid=$!
  for attempt in {1..120}; do
    if grep -q '^ready ' "$work/gateway.log"; then break; fi
    if ! kill -0 "$gateway_pid" 2> /dev/null || [ "$attempt" = 120 ]; then cat "$work/gateway.log" >&2; echo "The gateway did not start." >&2; exit 1; fi
    sleep 1
  done
  other_trace=$(sed -n 's/^ready .* other-trace \([0-9a-f]*\)$/\1/p' "$work/gateway.log")
  UI_API_ORIGIN=http://127.0.0.1:18182 TELEMETRY_E2E_OTHER_TRACE="$other_trace" \
    pnpm --filter @everything/ui-tests test:telemetry-e2e
fi

echo "Peak OpenObserve memory during the tests: $(cat "$work/peak" 2> /dev/null || echo unknown) MiB of ${memory}."
