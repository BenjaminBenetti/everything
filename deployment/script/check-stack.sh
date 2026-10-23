#!/usr/bin/env bash
# Check deployment tooling: script syntax, then lint and render the chart with each values file.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

for script in deployment/script/*.sh; do
  bash -n "$script"
done
# Scripts the chart mounts into upstream images, such as PostgreSQL's initialization.
for script in "$chart"/files/*/*.sh; do
  sh -n "$script"
done
# Every render needs credentials; the development values provide them.
credentials=(--values "$dev_values")
# Development defaults, remote clusters, then the ci/ examples that exercise optional features.
for values in "" "$chart/values.prod.yaml" "$chart"/ci/*-values.yaml; do
  arguments=("${credentials[@]}")
  if [ -n "$values" ]; then arguments+=(--values "$values"); fi
  helm lint "$chart" --strict --quiet "${arguments[@]}"
  # Lint only warns about missing required values; rendering fails on them.
  render_stack "${arguments[@]}" > /dev/null
done
# The release workflow builds each image the chart builds from the workspace that names it, for the
# platforms the workspace allows.
stack_image_workspaces | while read -r image workspace; do
  platforms=$(workspace_image_platforms "$workspace" linux/amd64,linux/arm64)
  if ! [[ $platforms =~ ^linux/(amd64|arm64)(,linux/(amd64|arm64))?$ ]]; then
    echo "$workspace builds $image for $platforms; use linux/amd64, linux/arm64, or both." >&2
    exit 1
  fi
done
# Teammate images carry the Fleet client of the release fleetd runs, for each architecture; a client
# of another version cannot talk to it.
dockerfile=services/teammate/container/Dockerfile
fleet_setting() { sed -n '/^fleet:/,/^[^ #]/p' "$chart/values.yaml" | sed -n "s/^$1: //p" | head -n 1; }
fleet_version=$(fleet_setting "  version")
fleet_release_url=$(fleet_setting "  releaseUrl")
fleet_additions=$(sed -e ':joined' -e '/\\$/N' -e 's/\\\n *//' -e 't joined' "$dockerfile" | grep -E '^(ADD|FROM) ')
for arch in amd64 arm64; do
  checksum=$(fleet_setting "    fleet-linux-$arch")
  expected="ADD --checksum=sha256:$checksum --chmod=755 $fleet_release_url/$fleet_version/fleet-linux-$arch /fleet"
  if [ "$(grep -A1 -xF "FROM scratch AS fleet-$arch" <<< "$fleet_additions" | tail -n 1)" != "$expected" ]; then
    echo "$dockerfile must install the Fleet client the chart pins for $arch: $expected" >&2
    exit 1
  fi
done
# The gateway image is the same Fleet release, by its tag without the leading v.
gateway_image=$(sed -n 's/^    upstreamImage: \(ghcr.io\/benjaminbenetti\/fleet-man\/gateway:.*\)/\1/p' "$chart/values.yaml")
if [[ $gateway_image != *":${fleet_version#v}@sha256:"* ]]; then
  echo "services.fleet-gateway must run the gateway image of Fleet $fleet_version, pinned by digest: $gateway_image" >&2
  exit 1
fi
# Telemetry storage runs OpenObserve's published image unchanged, pinned by digest so every node of
# either architecture runs the same build; deployment/script/test-telemetry.sh checks both platforms.
openobserve_image=$(sed -n 's/^    upstreamImage: \(docker.io\/openobserve\/openobserve:.*\)/\1/p' "$chart/values.yaml")
if [[ ! $openobserve_image =~ ^docker\.io/openobserve/openobserve:v[0-9.]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "services.openobserve must run OpenObserve's published image pinned by digest: $openobserve_image" >&2
  exit 1
fi
