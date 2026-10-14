#!/usr/bin/env bash
# Delete the local review stack and all of its data from Minikube; cluster:up recreates it from scratch.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh
mapfile -t workload < <(workload_namespaces)

if [ "${1:-}" != --yes ]; then
  if [ ! -t 0 ]; then
    echo "Refusing to delete without confirmation; pass --yes." >&2
    exit 1
  fi
  read -r -p "Delete namespaces $namespace and ${workload[*]} from $context, including the database, agent workspaces, artifacts, and Fleet instances? [y/N] " answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Nothing was deleted."
    exit 1
  fi
fi
helm uninstall "$release" --kube-context "$context" --namespace "$namespace" --ignore-not-found --wait
# The namespaces hold what the release keeps on uninstall: persistent volume claims, the workload
# namespaces themselves, the workloads, disks, and build jobs the artifact service created, and
# Fleet's instances.
kubectl --context "$context" delete namespace "$namespace" "${workload[@]}" --ignore-not-found --wait
echo "The local stack is deleted."
