FROM mcr.microsoft.com/devcontainers/base:ubuntu26.04

# kubectx, kubens, and k9s from their GitHub releases, checksum-verified.
# "latest" resolves at build time; pass a tag (e.g. v0.11.0) to pin.
ARG KUBECTX_VERSION=latest
ARG K9S_VERSION=latest

RUN <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Resolves "latest" via GitHub's release redirect, which isn't API rate limited.
resolve_tag() {
    local repo=$1 version=$2
    if [ "$version" = latest ]; then
        version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
        version=${version##*/}
    fi
    echo "v${version#v}"
}

# fetch <repo> <tag> <checksums file> <asset>...: download, verify, unpack.
fetch() {
    local repo=$1 tag=$2 sums=$3 asset
    shift 3
    local base="https://github.com/$repo/releases/download/$tag"
    curl -fsSLO "$base/$sums"
    for asset in "$@"; do
        curl -fsSLO "$base/$asset"
        grep "  $asset\$" "$sums" | sha256sum -c -
        tar -xzf "$asset"
    done
}

case "$(dpkg --print-architecture)" in
    amd64) kubectx_arch=x86_64; k9s_arch=amd64 ;;
    arm64) kubectx_arch=arm64;  k9s_arch=arm64 ;;
    *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
cd "$tmp"

tag=$(resolve_tag ahmetb/kubectx "$KUBECTX_VERSION")
fetch ahmetb/kubectx "$tag" checksums.txt \
    "kubectx_${tag}_linux_${kubectx_arch}.tar.gz" \
    "kubens_${tag}_linux_${kubectx_arch}.tar.gz"

tag=$(resolve_tag derailed/k9s "$K9S_VERSION")
fetch derailed/k9s "$tag" checksums.sha256 "k9s_Linux_${k9s_arch}.tar.gz"

install -m 0755 kubectx kubens k9s /usr/local/bin/
cd /
rm -rf "$tmp"
EOF
