#!/usr/bin/env bash
# Build, load, and deploy the local stack into Minikube with Helm, reusing existing volumes.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

# Image loading needs SSH access even when Kubernetes itself is reachable.
# Check it explicitly because Minikube can skip inaccessible nodes without failing image load.
if ! minikube --profile "$context" ssh -- true; then
  echo "Cannot access the local Minikube node. Repair its SSH connection before deploying." >&2
  exit 1
fi

# Helm installs into the release's namespace, which must admit Everything's privileged Docker
# sidecar; the chart creates the namespaces its services run workloads in.
kubectl --context "$context" apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    pod-security.kubernetes.io/enforce: privileged
EOF
pnpm build:images
images=$(stack_images --values "$dev_values")
for image in $images; do
  minikube --profile "$context" image load --daemon --overwrite=true "$image"
done
# Without values flags, Helm would reuse the previous release's values; the chart's values.yaml must win.
helm upgrade "$release" "$chart" --install --reset-values --kube-context "$context" --namespace "$namespace" \
  --values "$dev_values"
bash deployment/script/configure-local-registry.sh
# Fixed development tags leave pod specs unchanged, so restart to run the newly loaded images.
restart_stack
