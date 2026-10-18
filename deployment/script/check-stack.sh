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
