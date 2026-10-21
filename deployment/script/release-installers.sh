#!/usr/bin/env bash
# Write the installers a release publishes into a folder: install.sh, which installs the release's
# version by default, and install-k3s.sh, which runs exactly that copy of install.sh, downloaded from
# the same release and checked against its SHA-256, so it never installs another version.
#   release-installers.sh <version without v> <folder>
set -euo pipefail
version=$1
directory=$2
source=$(dirname "$0")

if ! [[ $version =~ ^[0-9A-Za-z.-]+$ ]]; then
  echo "Invalid version $version." >&2
  exit 1
fi
sed "s/^release_version=\"\"\$/release_version=\"$version\"/" "$source/install.sh" > "$directory/install.sh"
sha=$(sha256sum "$directory/install.sh" | awk '{ print $1 }')
sed -e "s/^release_version=\"\"\$/release_version=\"$version\"/" \
  -e "s/^installer_sha256=\"\"\$/installer_sha256=\"$sha\"/" \
  "$source/install-k3s.sh" > "$directory/install-k3s.sh"
# Fail if a line the installers read their release from has changed.
grep -qx "release_version=\"$version\"" "$directory/install.sh"
grep -qx "release_version=\"$version\"" "$directory/install-k3s.sh"
grep -qx "installer_sha256=\"$sha\"" "$directory/install-k3s.sh"
