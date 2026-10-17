#!/usr/bin/env bash
# Runs on every container start. Minikube needs the kernel's bridge netfilter and a running Docker
# daemon; when either is missing, the cluster steps are skipped with a warning that says how to fix
# it, and the rest of the workspace still works.
set -eu
here=$(dirname "$0")
source "$here/bridge-netfilter.sh"

# inotify limits are per user, and root in this container, minikube, and
# its pods all count as host root. Fedora's default of 128 instances runs
# out and kube-proxy crash-loops with "too many open files". Raise the
# limits (never lower them); this lasts until the host reboots.
raise_sysctl() {
    local key=$1 want=$2 have
    have=$(sysctl -n "$key")
    if [ "$have" -lt "$want" ]; then
        sudo sysctl -qw "$key=$want" || cat >&2 <<EOF
WARNING: couldn't raise $key from $have to $want, so kube-proxy and other
pods may crash with "too many open files". Raise it on the host, then
restart this container:

  echo '$key = $want' | sudo tee -a /etc/sysctl.d/99-inotify.conf
  sudo sysctl --system
EOF
    fi
}
raise_sysctl fs.inotify.max_user_instances 8192
raise_sysctl fs.inotify.max_user_watches 524288

# skip_cluster: finish without starting the development cluster, after a warning about what it
# lacks, so the container still starts.
skip_cluster() {
    cat >&2 <<'EOF'

Skipped starting Minikube; the rest of the workspace works without it. After
fixing the above, rerun this script or restart the container:

  bash .devcontainer/post-start.sh
EOF
    exit 0
}

# Without bridge netfilter, Minikube would start but its pods couldn't reach Services.
check_bridge_netfilter /proc/sys/net/bridge/bridge-nf-call-iptables || skip_cluster

# The docker-in-docker entrypoint launches dockerd in the background, so it may not be ready yet.
# dockerd can't start at all unless the container is privileged.
for _ in $(seq 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
done
if ! docker info >/dev/null 2>&1; then
    cat >&2 <<'EOF'
WARNING: Docker didn't start within a minute, so Minikube has nothing to run
on. Docker in this container needs the container to run privileged; make sure
the workspace allows privileged containers, and see /tmp/dockerd.log.
EOF
    skip_cluster
fi

# Start minikube and make it the current context, so kubectl, kubectx,
# kubens, and k9s all point at it.
if minikube status >/dev/null 2>&1; then
    minikube update-context
else
    minikube start --driver=docker
fi
kubectl config use-context minikube

# metrics-server reports pod and node CPU and memory, for `kubectl top` and k9s. Enabling it is safe
# to rerun but pulls an image, so a failure only warns.
minikube addons enable metrics-server ||
    echo "WARNING: metrics-server was not enabled; rerun 'minikube addons enable metrics-server'." >&2

# Traefik is the development cluster's ingress controller. Installing it needs network access, so a
# failure only warns; rerun the script once the network is available.
bash "$here/install-traefik.sh" ||
    echo "WARNING: Traefik was not installed; rerun .devcontainer/install-traefik.sh." >&2

# Minikube rewrites the node's hosts file when it starts, so map a deployed stack's registry hostname
# to the ingress again.
bash "$here/../deployment/script/configure-local-registry.sh" ||
    echo "WARNING: the node cannot pull from the stack's registry; rerun deployment/script/configure-local-registry.sh." >&2
