#!/usr/bin/env bash
# Install Traefik as the development cluster's default ingress controller; safe to rerun.
# The Everything chart's Ingresses use the default class: the application's on the `web` entrypoint
# and the artifact host's on the `artifacts` entrypoint. cluster:forward exposes both locally.
set -euo pipefail

helm repo add traefik https://traefik.github.io/charts --force-update >/dev/null
helm upgrade --install traefik traefik/traefik --version 41.7.1 \
    --kube-context minikube --namespace traefik --create-namespace \
    --set service.spec.type=ClusterIP \
    --set ingressClass.enabled=true \
    --set ingressClass.isDefaultClass=true \
    --set ports.artifacts.port=8081 \
    --set ports.artifacts.exposedPort=8081 \
    --set ports.artifacts.expose.default=true \
    --set ports.artifacts.protocol=TCP \
    --wait
