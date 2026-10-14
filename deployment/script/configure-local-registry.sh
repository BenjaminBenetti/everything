#!/usr/bin/env bash
# Let the Minikube node pull from the release's registry the way a remote cluster's nodes do: by its
# hostname, through the ingress, over HTTPS. The node resolves names without cluster DNS, so its hosts
# file maps the hostname to Traefik's in-cluster address, and its container runtime accepts Traefik's
# self-signed certificate for that host only. Minikube rewrites the hosts file whenever the node
# starts, so cluster:up and the dev container's start both run this; before the release is installed,
# it does nothing.
set -euo pipefail
cd "$(dirname "$0")/../.."
source deployment/script/stack-chart.sh

host=$(kubectl --context "$context" -n "$namespace" get ingress "$release-registry" --ignore-not-found \
  -o jsonpath='{.spec.rules[0].host}')
if [ -z "$host" ]; then
  echo "The release has no registry Ingress yet; the node needs no registry settings."
  exit 0
fi
address=$(kubectl --context "$context" -n "$ingress_namespace" get service "$ingress_service" \
  -o jsonpath='{.spec.clusterIP}')
# Both go into a root shell on the node, so only plain hostnames and IPv4 addresses are accepted.
if [[ ! "$host" =~ ^[A-Za-z0-9.-]+$ || ! "$address" =~ ^[0-9.]+$ ]]; then
  echo "Unexpected registry host '$host' or ingress address '$address'." >&2
  exit 1
fi

node_script=$(cat <<EOF
set -eu
awk -v host='$host' '\$2 != host' /etc/hosts > /tmp/hosts.everything
printf '%s\t%s\n' '$address' '$host' >> /tmp/hosts.everything
cat /tmp/hosts.everything > /etc/hosts
rm /tmp/hosts.everything
mkdir -p '/etc/containerd/certs.d/$host'
cat > '/etc/containerd/certs.d/$host/hosts.toml' <<'TOML'
server = "https://$host"

[host."https://$host"]
  capabilities = ["pull", "resolve"]
  skip_verify = true
TOML
EOF
)
# Minikube's ssh passes no standard input, so the script travels as base64 in the command itself.
minikube --profile "$context" ssh -- "echo $(base64 -w0 <<<"$node_script") | base64 -d | sudo sh"
echo "The node pulls from https://$host through $ingress_service at $address."
