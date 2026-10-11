#!/usr/bin/env bash
# Build, load, and deploy the local stack into Minikube with Helm, reusing existing volumes.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

# The namespace carries the pod-security policy and must exist before Helm installs into it.
kubectl --context "$context" apply -f deployment/cluster/namespace.yaml
pnpm build:images
images=$(stack_images --values "$dev_values")
for image in $images; do
  minikube image load "$image"
done
# Without values flags, Helm would reuse the previous release's values; the chart's values.yaml must win.
helm upgrade "$release" "$chart" --install --reset-values --kube-context "$context" --namespace "$namespace" \
  --values "$dev_values"
# Fixed development tags leave pod specs unchanged, so restart to run the newly loaded images.
restart_stack
