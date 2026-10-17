# Sourced by post-start.sh. Minikube's pods talk across a Linux bridge, and kube-proxy implements
# Services as iptables rules, so pods reach ClusterIP Services -- including cluster DNS (CoreDNS) --
# only when the kernel's br_netfilter module passes bridged traffic through iptables. Fedora hosts
# don't load the module by default. The container only reads the kernel's setting: loading modules
# and changing kernel settings belong to the host, so each warning says what to run there.

# check_bridge_netfilter <path>: report whether bridged traffic passes through iptables, from the
# bridge-nf-call-iptables setting at path. Returns 0 when it's enabled, 1 when it's disabled, and 2
# when it's missing, unreadable, or not 0 or 1. Anything but enabled prints a warning with the
# host-side fix to standard error.
check_bridge_netfilter() {
    local path=$1 value

    if [ ! -e "$path" ]; then
        cat >&2 <<EOF
WARNING: bridge netfilter is unavailable. The host kernel hasn't loaded
br_netfilter, so this doesn't exist:
  $path
and Minikube's pods couldn't reach Services, including cluster DNS. Load the
module on the host -- for a Kubernetes-backed workspace, the node it runs on --
and have it load at every boot:

  sudo modprobe br_netfilter
  echo br_netfilter | sudo tee /etc/modules-load.d/br_netfilter.conf
EOF
        return 2
    fi

    if ! value=$(cat -- "$path" 2>&1); then
        cat >&2 <<EOF
WARNING: bridge netfilter couldn't be checked:
  $value
so Minikube's pods might not reach Services, including cluster DNS. Make sure
the workspace container can read /proc/sys.
EOF
        return 2
    fi

    case $value in
    1)
        echo "Bridge netfilter is enabled, as Minikube's Services and cluster DNS need."
        return 0
        ;;
    0)
        cat >&2 <<EOF
WARNING: bridge netfilter is disabled. This is 0:
  $path
so bridged traffic bypasses iptables and Minikube's pods couldn't reach
Services, including cluster DNS. Enable it on the host -- for a
Kubernetes-backed workspace, the node it runs on -- and keep it enabled across
reboots:

  sudo sysctl -w net.bridge.bridge-nf-call-iptables=1
  echo 'net.bridge.bridge-nf-call-iptables = 1' | sudo tee /etc/sysctl.d/99-bridge-netfilter.conf

Each container's network has its own copy of this setting, starting at 1. If
the host already reports 1, the container's runtime turns it off; remove that
sysctl from the container's configuration.
EOF
        return 1
        ;;
    *)
        cat >&2 <<EOF
WARNING: bridge netfilter couldn't be checked. This holds '$value', not 0 or 1:
  $path
so Minikube's pods might not reach Services, including cluster DNS. On the
host, 'sysctl net.bridge.bridge-nf-call-iptables' should report 1.
EOF
        return 2
        ;;
    esac
}
