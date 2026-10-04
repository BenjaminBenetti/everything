#!/usr/bin/env bash
# Runs on every container start.
set -eu

# Fedora hosts don't load br_netfilter by default. Without it, bridged pod
# traffic bypasses iptables, so pods can't reach ClusterIP services -- most
# visibly, cluster DNS (CoreDNS) lookups time out. This container is
# privileged and has the host's /lib/modules mounted, so it can load the
# module into the host kernel. It stays loaded until the host reboots.
sysctl_path=/proc/sys/net/bridge/bridge-nf-call-iptables

if [ ! -e "$sysctl_path" ]; then
    sudo modprobe br_netfilter 2>/dev/null || true
fi

if [ "$(cat "$sysctl_path" 2>/dev/null)" = "1" ]; then
    echo "br_netfilter loaded: minikube pod networking and DNS are good to go."
else
    cat >&2 <<'EOF'
WARNING: br_netfilter is not loaded, so pods in minikube won't be able to
reach Services (including cluster DNS). Load it on the host, then restart
this container:

  sudo modprobe br_netfilter
  echo br_netfilter | sudo tee /etc/modules-load.d/br_netfilter.conf
EOF
fi

# Start minikube and make it the current context, so kubectl, kubectx,
# kubens, and k9s all point at it. The docker-in-docker entrypoint launches
# dockerd in the background, so it may not be ready yet.
for _ in $(seq 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
done

if minikube status >/dev/null 2>&1; then
    minikube update-context
else
    minikube start --driver=docker
fi
kubectl config use-context minikube
