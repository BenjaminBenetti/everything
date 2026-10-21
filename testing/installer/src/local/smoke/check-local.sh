#!/usr/bin/env bash
# Check a local installation made by install-k3s.sh end to end, the way this computer, its browser,
# the cluster's node, and Everything's own clients use it, with ordinary certificate verification
# throughout. Run on the computer it installed on, as the user who ran it:
#   check-local.sh <registry-check binary for the node's architecture>
set -euo pipefail
registry_check=$1
state=${XDG_DATA_HOME:-$HOME/.local/share}/everything-local
kc() { kubectl --kubeconfig "$state/kubeconfig" --context everything-local "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}

step "HTTPS on each local name with the system's trust store"
curl --fail --silent --show-error --output /dev/null https://everything.internal/health/ready
[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://images.everything.internal/v2/)" = 401 ] ||
  fail "the registry did not ask for credentials"
code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://artifacts.everything.internal/)
echo "artifact host answered HTTP $code"
openssl s_client -connect 127.0.0.1:443 -servername everything.internal -verify_hostname everything.internal \
  -verify_return_error -CApath /etc/ssl/certs < /dev/null 2>&1 | grep -q 'Verify return code: 0 (ok)' ||
  fail "OpenSSL did not verify the certificate"

step "Served on loopback only"
address=$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
if timeout 5 bash -c "exec 9<>/dev/tcp/$address/443" 2> /dev/null; then
  fail "port 443 answers on $address"
fi
echo "port 443 does not answer on $address"
if kc -n kube-system get daemonsets -o name | grep -q svclb; then fail "ServiceLB runs"; fi

step "Private files"
[ "$(stat -c %a "$state")" = 700 ] || fail "$state is not private"
[ "$(stat -c %a "$state/ca/ca-key.pem")" = 600 ] || fail "the authority's key is not private"
[ "$(stat -c %a "$state/kubeconfig")" = 600 ] || fail "the kubeconfig is not private"
[ "$(stat -c %U "$state/kubeconfig")" = "$(id -un)" ] || fail "the kubeconfig belongs to someone else"
# Every Secret value decoded, and every ConfigMap value, must lack the key's body.
key_line=$(sed -n 2p "$state/ca/ca-key.pem")
if {
  kc get secrets -A -o json | jq -r '.items[].data // {} | .[]' | while read -r value; do base64 -d <<< "$value"; done
  kc get configmaps -A -o json | jq -r '.items[].data // {} | .[]'
} | grep -qF "$key_line"; then
  fail "the authority's key is in the cluster"
fi
echo "the authority's key stays in $state/ca"

step "Pods resolve the local names to Traefik"
traefik=$(kc -n kube-system get service traefik -o jsonpath='{.spec.clusterIP}')
kc -n everything exec everything-0 -c docker -- nslookup images.everything.internal | tee /dev/stderr |
  grep -qF "$traefik" || fail "the registry's name does not lead to Traefik in pods"

step "Push through the Docker sidecar Fleet builds with"
# The sidecar serves its engine only on the socket it shares with Everything's container.
docker_host=DOCKER_HOST=unix:///run/docker-socket/docker.sock
settings=$state/everything-values.yaml
username=$(yq -r '.secrets."registry-credentials".username' "$settings")
kc -n everything exec -i everything-0 -c docker -- env "$docker_host" docker login images.everything.internal --username "$username" \
  --password-stdin < <(yq -r '.secrets."registry-credentials".password' "$settings")
kc -n everything exec everything-0 -c docker -- env "$docker_host" docker pull --quiet docker.io/library/busybox:1.37.0
kc -n everything exec everything-0 -c docker -- env "$docker_host" docker tag docker.io/library/busybox:1.37.0 images.everything.internal/smoke/busybox:1
kc -n everything exec everything-0 -c docker -- env "$docker_host" docker push --quiet images.everything.internal/smoke/busybox:1

step "The node pulls from the registry"
kc create namespace everything-smoke --dry-run=client -o yaml | kc apply -f -
kc -n everything-smoke create secret docker-registry pull --docker-server images.everything.internal \
  --docker-username "$username" --docker-password "$(yq -r '.secrets."registry-credentials".password' "$settings")" \
  --dry-run=client -o yaml | kc apply -f - > /dev/null
kc -n everything-smoke apply -f - << 'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: pulled
spec:
  imagePullSecrets: [{ name: pull }]
  containers:
    - name: pulled
      image: images.everything.internal/smoke/busybox:1
      imagePullPolicy: Always
      command: [sleep, "3600"]
EOF
kc -n everything-smoke wait --for=condition=Ready pod/pulled --timeout=180s ||
  {
    kc -n everything-smoke describe pod pulled
    fail "the node did not pull from the registry"
  }

step "fleetd's Go registry client trusts the registry"
kc -n everything cp "$registry_check" everything-0:/tmp/registry-check -c api
kc -n everything exec everything-0 -c api -- chmod 755 /tmp/registry-check
kc -n everything exec everything-0 -c api -- /tmp/registry-check images.everything.internal
# Without the authority's folder, Go rejects the certificate, so the check above proves the trust.
if kc -n everything exec everything-0 -c api -- env -u SSL_CERT_DIR /tmp/registry-check images.everything.internal; then
  fail "the registry was trusted without the local authority"
fi
[ -z "$(kc -n everything exec everything-0 -c api -- printenv FLEET_REGISTRY_INSECURE || true)" ] ||
  fail "Fleet treats the registry as insecure"

step "All checks passed"
