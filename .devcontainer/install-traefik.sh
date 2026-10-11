#!/usr/bin/env bash
# Install Traefik as the development cluster's default ingress controller; safe to rerun.
# The Everything chart's Ingress uses the default class; cluster:forward exposes Traefik locally.
set -euo pipefail

helm repo add traefik https://traefik.github.io/charts --force-update >/dev/null
helm upgrade --install traefik traefik/traefik --version 41.7.1 \
    --kube-context minikube --namespace traefik --create-namespace \
    --set service.spec.type=ClusterIP \
    --set ingressClass.enabled=true \
    --set ingressClass.isDefaultClass=true \
    --wait
