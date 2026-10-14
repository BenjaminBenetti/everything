#!/usr/bin/env bash
# Install Traefik as the development cluster's default ingress controller; safe to rerun.
# The Everything chart's Ingresses use the default class: the application's on the `web` entrypoint
# and the artifact host's on the `artifacts` entrypoint, which cluster:forward exposes locally, and
# the registry's on the `websecure` entrypoint, which the cluster reaches by the registry's hostname.
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
    --set-string ports.websecure.transport.respondingTimeouts.readTimeout=0s \
    --wait

# Pods resolve development hostnames under .test, such as the registry's, to Traefik, as public DNS
# points a remote cluster's hostnames at its ingress. CoreDNS reloads its configuration on its own.
rule='rewrite name regex ^.+\.test\.?$ traefik.traefik.svc.cluster.local. answer auto'
corefile=$(kubectl --context minikube -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')
if ! grep -qF "$rule" <<<"$corefile"; then
    corefile=$(RULE="$rule" awk '{ print } /^\.:53 \{$/ { print "    " ENVIRON["RULE"] }' <<<"$corefile")
    kubectl --context minikube -n kube-system create configmap coredns --from-literal=Corefile="$corefile" \
        --dry-run=client -o yaml |
        kubectl --context minikube apply --server-side --force-conflicts --field-manager=everything-dev -f -
fi
