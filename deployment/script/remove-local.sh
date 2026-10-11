#!/usr/bin/env bash
# Delete the local review stack and all of its data from Minikube; cluster:up recreates it from scratch.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

if [ "${1:-}" != --yes ]; then
  if [ ! -t 0 ]; then
    echo "Refusing to delete without confirmation; pass --yes." >&2
    exit 1
  fi
  read -r -p "Delete namespace $namespace from $context, including its database and agent workspaces? [y/N] " answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "Nothing was deleted."
    exit 1
  fi
fi
helm uninstall "$release" --kube-context "$context" --namespace "$namespace" --ignore-not-found --wait
# The namespace holds what the release keeps on uninstall: its persistent volume claims.
kubectl --context "$context" delete namespace "$namespace" --ignore-not-found --wait
echo "The local stack is deleted."
