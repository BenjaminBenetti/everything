# Shared settings and helpers for the stack's Helm release; sourced by the deployment scripts.
# Service-specific facts (images, restart order) are read from the rendered chart.
context=minikube
release=everything
namespace=everything
chart=deployment/helm
# Development credentials and realm seed, layered over values.yaml.
dev_values=$chart/values.dev.yaml
# Development ingress controller, installed by .devcontainer/install-traefik.sh.
ingress_namespace=traefik
ingress_service=traefik
# cluster:forward serves the ingress here; it matches global.publicOrigin in values.yaml.
local_port=8080
local_origin=http://localhost:$local_port
# The artifact host's entrypoint, forwarded to the same port; it matches global.artifactOrigin.
artifact_local_port=8081

# Render the release's manifests; extra arguments, such as --values, are passed to Helm.
render_stack() {
  helm template "$release" "$chart" --namespace "$namespace" "$@"
}

# List the namespaces the chart creates for dynamic artifacts, their builds, and Fleet instances.
workload_namespaces() {
  render_stack --values "$dev_values" --show-only templates/namespaces.yaml | sed -n 's/^  name: *//p'
}

# List the images the release builds, as `<image>:<tag>`, leaving out upstream images that nodes pull
# from their publishers; arguments are passed to render_stack. Rendering under a placeholder registry
# tells them apart: only built images take the global registry.
stack_images() {
  local marker=built.invalid
  render_stack "$@" --set global.image.registry="$marker" |
    sed -n "s|^[ -]*image: *\"\{0,1\}$marker/\([^\"]*\)\"\{0,1\}\$|\1|p" | sort -u
}

# List each image the release builds with the workspace that builds it, as `<image> <workspace>` lines.
# A workspace names both in its build:image script: `build-image.sh <workspace> <image>:<tag>`.
stack_image_workspaces() {
  local image workspace
  for image in $(stack_images --values "$dev_values" | sed 's/:[^:]*$//'); do
    workspace=$(sed -n "s/.*build-image\.sh \([^ ]*\) $image:.*/\1/p" services/*/package.json)
    if [ "$(printf '%s' "$workspace" | grep -c .)" -ne 1 ]; then
      echo "Expected exactly one workspace whose build:image script builds $image." >&2
      return 1
    fi
    echo "$image $workspace"
  done
}

# Find the workload containing a named environment setting in the rendered chart.
stack_workload_with_environment() {
  local setting=$1
  shift
  render_stack "$@" | awk -v setting="$setting" '
    function emit() { if (found && kind && name) print tolower(kind) "/" name }
    /^---/ { emit(); kind=""; name=""; found=0 }
    /^kind: (Deployment|StatefulSet)$/ { kind=$2 }
    /^  name:/ { if (kind) name=$2 }
    /^[[:space:]]*- name:/ { value=$3; gsub(/"/, "", value); if (value == setting) found=1 }
    END { emit() }
  '
}

# Restart the release's workloads wave by wave, waiting for each wave before starting the next.
restart_stack() {
  local selector="app.kubernetes.io/instance=$release" kinds=deployments,statefulsets wave workload
  local waves
  waves=$(kubectl --context "$context" -n "$namespace" get "$kinds" -l "$selector" \
    -o jsonpath='{range .items[*]}{.metadata.labels.rollout-wave}{"\n"}{end}' | sort -nu)
  for wave in $waves; do
    for workload in $(kubectl --context "$context" -n "$namespace" get "$kinds" \
      -l "$selector,rollout-wave=$wave" -o name); do
      kubectl --context "$context" -n "$namespace" rollout restart "$workload"
    done
    for workload in $(kubectl --context "$context" -n "$namespace" get "$kinds" \
      -l "$selector,rollout-wave=$wave" -o name); do
      kubectl --context "$context" -n "$namespace" rollout status "$workload" --timeout=300s
    done
  done
}

# Wait until the API and Keycloak answer through the ingress, for example after pods were replaced.
wait_until_serving() {
  local attempt
  for attempt in {1..120}; do
    if curl -fs -o /dev/null "$local_origin/health/ready" &&
      curl -fs -o /dev/null "$local_origin/auth/realms/everything/.well-known/openid-configuration"; then
      return 0
    fi
    sleep 1
  done
  echo "The stack did not answer at $local_origin." >&2
  return 1
}

# Serve the ingress at $local_origin for the calling script, reusing a running cluster:forward if one
# already does. stop_forward ends only a forward started here.
forward_pid=
forward_log=
start_forward() {
  if curl -fs -o /dev/null "$local_origin/health/live"; then return 0; fi
  forward_log=$(mktemp)
  bash deployment/script/forward-local.sh > "$forward_log" 2>&1 &
  forward_pid=$!
  local attempt
  for attempt in {1..100}; do
    if ! kill -0 "$forward_pid" 2>/dev/null; then
      cat "$forward_log" >&2
      echo "Port forwarding failed; is port $local_port used by something other than the stack?" >&2
      return 1
    fi
    if grep -q "Forwarding from 127.0.0.1:$local_port" "$forward_log"; then return 0; fi
    sleep 0.1
  done
  echo "Port forwarding timed out." >&2
  return 1
}

# Stop the forward started by start_forward, if any.
stop_forward() {
  if [ -n "$forward_pid" ]; then
    kill "$forward_pid" 2>/dev/null || true
    wait "$forward_pid" 2>/dev/null || true
    forward_pid=
  fi
  if [ -n "$forward_log" ]; then rm -f "$forward_log"; fi
}
