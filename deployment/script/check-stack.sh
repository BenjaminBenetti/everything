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
# The release workflow builds each image the chart builds from the workspace that names it.
stack_image_workspaces > /dev/null
# Teammate images carry the Fleet client of the release fleetd runs, for each architecture; a client
# of another version cannot talk to it.
dockerfile=services/teammate/container/Dockerfile
fleet_setting() { sed -n "s/^$1: //p" "$chart/values.yaml" | head -n 1; }
fleet_version=$(fleet_setting "  version")
fleet_release_url=$(fleet_setting "  releaseUrl")
fleet_additions=$(sed -e ':joined' -e '/\\$/N' -e 's/\\\n *//' -e 't joined' "$dockerfile" | grep '^ADD ')
for arch in amd64 arm64; do
  checksum=$(fleet_setting "    fleet-linux-$arch")
  expected="ADD --checksum=sha256:$checksum --chmod=755 $fleet_release_url/$fleet_version/fleet-linux-$arch /fleet"
  if ! grep -qxF -- "$expected" <<< "$fleet_additions"; then
    echo "$dockerfile must install the Fleet client the chart pins for $arch: $expected" >&2
    exit 1
  fi
done
