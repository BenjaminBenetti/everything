#!/usr/bin/env bash
# Install Everything on this Linux computer, in a local k3s cluster served over locally trusted HTTPS:
#   curl -fsSL https://github.com/BenjaminBenetti/everything/releases/download/<tag>/install-k3s.sh | bash
# It checks the computer, explains every change that needs root, and asks before making them. Then
# it installs k3s, creates a certificate authority that can sign only Everything's local hostnames,
# trusts it on this computer, in its browsers, and in the cluster, and runs the release's regular
# installer (install.sh) with the local hostnames, ingress, TLS, and storage already answered.
# Everything is then served at https://everything.internal on 127.0.0.1 only. Rerunning it reuses
# what earlier runs made, and it never changes a k3s it did not install.
#
# The copy each release publishes runs that release's installer, checked against its SHA-256. From
# a source checkout, pass `--installer deployment/script/install.sh`.
set -euo pipefail

# The version and installer the release workflow sets in the copy it publishes; empty in source.
release_version=""
installer_sha256=""
repository=BenjaminBenetti/everything

# k3s, through its install script for this version, which checks the k3s binary's SHA-256 itself.
k3s_version=v1.36.5+k3s1
k3s_install_url=https://raw.githubusercontent.com/k3s-io/k3s/v1.36.5%2Bk3s1/install.sh
k3s_install_sha256=46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad
# Helm, downloaded into the installer's own directory when this computer lacks 3.8 or newer.
helm_version=v4.3.0
helm_sha256() {
  case $1 in
    amd64) echo 86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;;
    arm64) echo 31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;;
  esac
}

# Hostnames under .internal, which is reserved for private use. This computer's hosts file points
# them at 127.0.0.1, and the cluster's DNS points them at Traefik.
app_host=everything.internal
artifact_host=artifacts.everything.internal
registry_host=images.everything.internal
namespace=everything
release=everything
context_name=everything-local
tls_secret=everything-local-tls
ca_secret=everything-local-ca
# The local cluster needs this much memory and free disk.
min_memory_kib=7000000
min_disk_kib=$((20 * 1024 * 1024))
# Bounds on waiting for the cluster and Everything.
cluster_timeout=600
everything_timeout=1800

# Prefix of every system path, empty except in the installer's tests.
system_root=""

# Lines that mark what this installer wrote.
marker="# Written by Everything's local installer (install-k3s.sh)."
hosts_begin="# BEGIN Everything local installer (install-k3s.sh)"
hosts_end="# END Everything local installer"
ca_nickname_prefix="Everything local CA"

# Working state, set as the installer runs.
work="" phase="" installer="" arch="" run_as_root=false trust_style="" package_manager=""
packages=() k3s_state="" k3s_restart=false kubeconfig="" helm_bin="" kubectl_bin="" ca_fingerprint=""
state_dir="" ca_dir="" tls_dir="" bin_dir="" finished=false

# ---------------------------------------------------------------------------------------------------
# Terminal: prompts read the terminal on descriptor 3, because curl's output is the shell's input.
# ---------------------------------------------------------------------------------------------------

say() { printf '%s\n' "$*" >&2; }
fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

read_line() {
  IFS= read -r "$@" <&3 || fail "The installer stopped reading answers; run it from a terminal."
}

# confirm <prompt> <Y|N>: succeed on yes; the second argument is the answer Enter gives.
confirm() {
  local reply hint=y/N
  if [ "$2" = Y ]; then hint=Y/n; fi
  while true; do
    printf '%s [%s]: ' "$1" "$hint" >&2
    read_line reply
    case "${reply:-$2}" in
      [Yy] | [Yy][Ee][Ss]) return 0 ;;
      [Nn] | [Nn][Oo]) return 1 ;;
    esac
  done
}

usage() {
  cat << EOF
Usage: install-k3s.sh [--installer <install.sh>] [--remove-trust] [--help]

Installs k3s $k3s_version and Everything on this Linux computer, served at https://$app_host
on 127.0.0.1 only, with a certificate authority this computer and its browsers trust.

  --installer <file>  Run this copy of install.sh; required from a source checkout, whose
                      install-k3s.sh names no release.
  --remove-trust      Stop trusting the local certificate authority, in the system store and in
                      browsers, and remove the installer's lines from /etc/hosts. The cluster,
                      Everything, and the authority's files are kept.
  --help              Show this help.

Rerun the installer at any time; it reuses its earlier work and settings in
\${XDG_DATA_HOME:-~/.local/share}/everything-local. To remove everything it made:
  /usr/local/bin/k3s-uninstall.sh       deletes the cluster and all of Everything's data
  install-k3s.sh --remove-trust         removes the trust and hosts entries
  rm -rf ~/.local/share/everything-local  deletes the authority, settings, and kubeconfig
EOF
}

# ---------------------------------------------------------------------------------------------------
# Commands: root for system changes only, the private kubeconfig for every cluster command.
# ---------------------------------------------------------------------------------------------------

as_root() {
  if [ "$run_as_root" = true ]; then "$@"; else sudo -- "$@"; fi
}

kc() { "$kubectl_bin" --kubeconfig "$kubeconfig" --context "$context_name" "$@"; }

# A cluster check that gives up on an unresponsive API server.
kc_check() { kc --request-timeout=20s "$@"; }

# download <url> <file> <sha256>: fetch to a file, never into a shell, and check its digest.
download() {
  local url=$1 file=$2 expected=$3 actual
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 \
    --connect-timeout 20 --max-time 900 --output "$file" "$url" ||
    fail "Could not download $url. Check the Internet connection and rerun the installer."
  actual=$(sha256sum "$file" | awk '{ print $1 }')
  [ "$actual" = "$expected" ] ||
    fail "$url has SHA-256 $actual, not the expected $expected; it was not used."
}

# put_root_file <mode> <source> <destination>: install a file as root; fail on a symlink, and
# succeed only when the destination changed. Root compares them, since k3s's folders are private.
put_root_file() {
  local destination=$3
  if as_root test -L "$destination"; then fail "$destination is a symbolic link; the installer will not write through it."; fi
  if as_root cmp -s "$2" "$destination"; then return 1; fi
  as_root install -d -m 0755 "$(dirname "$destination")"
  as_root install -m "$1" "$2" "$destination"
}

# private_dir <path>: a directory only this user can read, refusing symlinks and others' folders.
private_dir() {
  if [ -L "$1" ]; then fail "$1 is a symbolic link; remove it or set XDG_DATA_HOME elsewhere."; fi
  if [ -e "$1" ]; then
    [ -d "$1" ] || fail "$1 is not a directory."
    [ "$(stat -c %u "$1")" = "$(id -u)" ] || fail "$1 belongs to another user."
  else
    (umask 077 && mkdir -p "$1")
  fi
  chmod 700 "$1"
}

# wait_until <seconds> <description> <command>...: retry a command until it succeeds or time runs
# out, saying what it waits for once the first attempt fails.
wait_until() {
  local limit=$1 description=$2 deadline said=false
  shift 2
  deadline=$(($(date +%s) + limit))
  until "$@" > /dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "Timed out after ${limit}s waiting for $description."
    fi
    if [ "$said" = false ]; then
      say "  Waiting for $description..."
      said=true
    fi
    sleep 5
  done
}

# ---------------------------------------------------------------------------------------------------
# Checks: everything the installer needs, before it changes anything.
# ---------------------------------------------------------------------------------------------------

check_platform() {
  [ "$(uname -s)" = Linux ] || fail "This installer runs on Linux only; use install.sh with an existing cluster elsewhere."
  case $(uname -m) in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "k3s here supports x86-64 and ARM64 computers, not $(uname -m)." ;;
  esac
  if grep -qi microsoft "$system_root/proc/sys/kernel/osrelease" 2> /dev/null; then
    fail "This installer supports native Linux, not WSL."
  fi
  if [ ! -d "$system_root/run/systemd/system" ] || ! command -v systemctl > /dev/null; then
    fail "This installer needs systemd to run k3s as a service."
  fi
}

check_user() {
  if [ "$(id -u)" = 0 ]; then
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
      fail "Run the installer as yourself, not with sudo; it asks for sudo only for the steps that need root."
    fi
    run_as_root=true
  else
    command -v sudo > /dev/null || fail "The installer needs sudo to install k3s and trust its certificates."
  fi
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || fail "HOME must name your home directory."
}

check_tools() {
  local tool
  for tool in curl sha256sum tar awk sed grep cmp install stat mktemp df ss timeout base64; do
    command -v "$tool" > /dev/null || fail "$tool is required; install it with your package manager and rerun."
  done
  if command -v apt-get > /dev/null; then
    package_manager=apt-get
  elif command -v dnf > /dev/null; then
    package_manager=dnf
  else
    fail "This installer supports Debian, Ubuntu, Fedora, and related distributions with apt-get or dnf."
  fi
  # OpenSSL makes the certificates, certutil trusts them in browsers, and the CA store tools
  # trust them system-wide.
  if ! command -v openssl > /dev/null; then packages+=(openssl); fi
  if ! command -v certutil > /dev/null; then
    if [ "$package_manager" = apt-get ]; then packages+=(libnss3-tools); else packages+=(nss-tools); fi
  fi
  if [ -d "$system_root/etc/pki/ca-trust/source/anchors" ] || [ "$package_manager" = dnf ]; then
    trust_style=pki
    command -v update-ca-trust > /dev/null || packages+=(ca-certificates)
  else
    trust_style=debian
    command -v update-ca-certificates > /dev/null || packages+=(ca-certificates)
  fi
}

check_resources() {
  local memory path=$system_root/var/lib available
  memory=$(awk '/^MemTotal:/ { print $2 }' "$system_root/proc/meminfo" 2> /dev/null || true)
  if [ -n "$memory" ] && [ "$memory" -lt "$min_memory_kib" ]; then
    fail "Everything needs at least 8 GB of memory; this computer has $((memory / 1024)) MB."
  fi
  while [ ! -d "$path" ]; do path=$(dirname "$path"); done
  available=$(df -Pk "$path" | awk 'NR == 2 { print $4 }')
  if [ -n "$available" ] && [ "$available" -lt "$min_disk_kib" ]; then
    fail "Everything needs at least 20 GB free under /var/lib; $path has $((available / 1024 / 1024)) GB."
  fi
}

# owned: this installer's k3s; fresh: no Kubernetes here yet. Anything else is refused.
check_k3s() {
  local path
  if grep -qxF "$marker" "$system_root/etc/rancher/k3s/config.yaml.d/50-everything-local.yaml" 2> /dev/null; then
    k3s_state=owned
    if [ -e "$system_root/etc/systemd/system/k3s-agent.service" ]; then
      fail "This computer runs a k3s agent; the local installer supports only its own single-server k3s."
    fi
    path=$system_root/etc/rancher/k3s/registries.yaml
    if [ -e "$path" ] && ! grep -qxF "$marker" "$path"; then
      fail "/etc/rancher/k3s/registries.yaml was not written by this installer. Move it aside, rerun the installer, then merge your settings back into the file it writes."
    fi
    return
  fi
  for path in /usr/local/bin/k3s /etc/systemd/system/k3s.service /etc/systemd/system/k3s-agent.service \
    /etc/rancher/k3s /var/lib/rancher/k3s /etc/rancher/rke2 /var/lib/rancher/rke2 /snap/microk8s; do
    if [ -e "$system_root$path" ]; then
      fail "Found $path from a Kubernetes installation this installer did not make. It changes only a k3s it installed; install Everything there with install.sh instead, or remove that installation first."
    fi
  done
  k3s_state=fresh
}

listening() { [ -n "$(ss -Hltn "sport = :$1" 2> /dev/null)" ]; }

check_ports() {
  local port
  if [ "$k3s_state" = fresh ]; then
    for port in 443 6443 10250; do
      if listening "$port"; then
        fail "Port $port is in use by another program. k3s and Everything need it; stop that program, or install Everything on another computer."
      fi
    done
  elif listening 443; then
    # Traefik's port is published by forwarding rules, not a listener, so this is someone else.
    say "Warning: another program listens on port 443; https://$app_host is served by k3s on 127.0.0.1 only."
  fi
}

# This computer's hosts file must be a plain file that maps the local names nowhere else.
check_hosts() {
  local hosts=$system_root/etc/hosts name
  if [ -L "$hosts" ]; then fail "/etc/hosts is a symbolic link; the installer will not write through it."; fi
  [ -f "$hosts" ] || fail "/etc/hosts is missing."
  for name in "$app_host" "$artifact_host" "$registry_host"; do
    if strip_hosts_block < "$hosts" | awk -v name="$name" '!/^[ \t]*#/ { for (i = 2; i <= NF; i++) if ($i == name) found = 1 } END { exit !found }'; then
      fail "/etc/hosts already maps $name; remove that line and rerun the installer."
    fi
  done
}

check_state() {
  state_dir=${XDG_DATA_HOME:-$HOME/.local/share}/everything-local
  ca_dir=$state_dir/ca
  tls_dir=$state_dir/tls
  bin_dir=$state_dir/bin
  kubeconfig=$state_dir/kubeconfig
  local path
  for path in "$state_dir" "$ca_dir" "$tls_dir" "$bin_dir" "$kubeconfig" "$ca_dir/ca.pem" "$ca_dir/ca-key.pem"; do
    if [ -L "$path" ]; then fail "$path is a symbolic link; the installer keeps its files only in plain files."; fi
    if [ -e "$path" ] && [ "$(stat -c %u "$path")" != "$(id -u)" ]; then fail "$path belongs to another user."; fi
  done
}

choose_installer() {
  if [ -n "$release_version" ]; then
    [ -z "$installer" ] || fail "This copy installs Everything $release_version with its own installer; --installer is for source checkouts."
    return
  fi
  [ -n "$installer" ] ||
    fail "This copy of install-k3s.sh names no release. Download it from a release, or pass --installer deployment/script/install.sh from a source checkout."
  [ -f "$installer" ] && [ -r "$installer" ] || fail "Cannot read the installer $installer."
}

# ---------------------------------------------------------------------------------------------------
# Plan: what the installer changes as root, which the person agrees to before it starts.
# ---------------------------------------------------------------------------------------------------

explain_plan() {
  say "Everything's local installer sets up Everything on this computer, at https://$app_host."
  say ""
  say "With your permission it uses sudo to:"
  if [ "${#packages[@]}" -gt 0 ]; then say "  - install ${packages[*]} with $package_manager"; fi
  if [ "$k3s_state" = fresh ]; then
    say "  - install k3s $k3s_version as the k3s system service, with its files under /etc/rancher/k3s"
    say "    and /var/lib/rancher/k3s, and kubectl access only through a private kubeconfig"
  else
    say "  - update the settings of the k3s it installed earlier, restarting k3s if they change"
  fi
  say "  - serve Everything's HTTPS port on 127.0.0.1:443 only, through k3s's Traefik"
  say "  - map $app_host, $artifact_host, and $registry_host to 127.0.0.1 in /etc/hosts"
  say "  - trust a certificate authority for those names only in the system certificate store and in k3s"
  say ""
  say "As you, it trusts that authority in Chrome, Chromium, and Firefox certificate databases in your"
  say "home folder, and keeps its private key, your settings, and the cluster's kubeconfig in"
  say "$state_dir, readable only by you. ~/.kube/config is not changed."
  say ""
  say "It downloads k3s, Helm if needed, Everything's installer, and Everything's images from the"
  say "Internet. Everything needs 8 GB of memory (16 GB recommended) and 20 GB of disk (50 GB recommended)."
  say ""
  confirm "Continue?" N || {
    say "Nothing changed."
    exit 0
  }
  if [ "$run_as_root" = false ]; then
    sudo -v || fail "sudo did not grant root access; nothing changed."
  fi
}

# ---------------------------------------------------------------------------------------------------
# Tools: packages, k3s's install script, Helm, and Everything's installer.
# ---------------------------------------------------------------------------------------------------

install_packages() {
  if [ "${#packages[@]}" -eq 0 ]; then return; fi
  say "Installing ${packages[*]}..."
  if [ "$package_manager" = apt-get ]; then
    as_root apt-get update -qq || fail "apt-get could not update its package lists."
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}" ||
      fail "apt-get could not install ${packages[*]}."
  else
    as_root dnf install -y -q "${packages[@]}" || fail "dnf could not install ${packages[*]}."
  fi
}

# Helm 3.8 or newer from this computer, or the pinned release in the installer's own folder.
choose_helm() {
  local found major minor
  if found=$(helm version --template '{{.Version}}' 2> /dev/null); then
    found=${found#v}
    major=${found%%.*}
    minor=${found#*.}
    minor=${minor%%.*}
    if [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] && { [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 8 ]; }; }; then
      helm_bin=$(command -v helm)
      return
    fi
  fi
  helm_bin=$bin_dir/helm
  if [ -x "$helm_bin" ] && [ "$("$helm_bin" version --template '{{.Version}}' 2> /dev/null)" = "$helm_version" ]; then
    return
  fi
  say "Downloading Helm $helm_version..."
  download "https://get.helm.sh/helm-$helm_version-linux-$arch.tar.gz" "$work/helm.tar.gz" "$(helm_sha256 "$arch")"
  tar -xzf "$work/helm.tar.gz" -C "$work" "linux-$arch/helm"
  install -m 0755 "$work/linux-$arch/helm" "$helm_bin"
}

fetch_installer() {
  if [ -n "$installer" ]; then return; fi
  installer=$work/install.sh
  say "Downloading Everything $release_version's installer..."
  download "https://github.com/$repository/releases/download/v$release_version/install.sh" "$installer" "$installer_sha256"
}

# ---------------------------------------------------------------------------------------------------
# Certificates: a certificate authority constrained to the local names, whose private key stays in
# this user's folder, and one certificate for all three names, kept only there and in the Secret
# Traefik serves it from.
# ---------------------------------------------------------------------------------------------------

make_authority() {
  private_dir "$ca_dir"
  if [ -f "$ca_dir/ca.pem" ] && [ -f "$ca_dir/ca-key.pem" ]; then
    chmod 600 "$ca_dir/ca-key.pem"
  else
    say "Creating the local certificate authority..."
    (
      umask 077
      openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 3650 \
        -subj "/O=Everything local installer/CN=$ca_nickname_prefix $(id -un)@$(uname -n)" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -addext "nameConstraints=critical,permitted;DNS:$app_host" \
        -addext "subjectKeyIdentifier=hash" \
        -keyout "$ca_dir/ca-key.pem.new" -out "$ca_dir/ca.pem.new" 2> "$work/openssl.log"
    ) || fail "OpenSSL could not create the certificate authority: $(tail -n 1 "$work/openssl.log")"
    mv "$ca_dir/ca-key.pem.new" "$ca_dir/ca-key.pem"
    mv "$ca_dir/ca.pem.new" "$ca_dir/ca.pem"
  fi
  chmod 644 "$ca_dir/ca.pem"
  ca_fingerprint=$(openssl x509 -in "$ca_dir/ca.pem" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' |
    tr '[:upper:]' '[:lower:]' | cut -c 1-16)
  [ -n "$ca_fingerprint" ] || fail "Cannot read the certificate authority in $ca_dir/ca.pem."
}

# A certificate is reused while the authority signed it, it names every host, and it has a month left.
certificate_current() {
  local names
  [ -f "$tls_dir/tls.crt" ] && [ -f "$tls_dir/tls.key" ] || return 1
  openssl verify -CAfile "$ca_dir/ca.pem" "$tls_dir/tls.crt" > /dev/null 2>&1 || return 1
  openssl x509 -in "$tls_dir/tls.crt" -noout -checkend 2592000 > /dev/null 2>&1 || return 1
  names=$(openssl x509 -in "$tls_dir/tls.crt" -noout -text)
  grep -qF "DNS:$app_host" <<< "$names" && grep -qF "DNS:$artifact_host" <<< "$names" &&
    grep -qF "DNS:$registry_host" <<< "$names"
}

make_certificate() {
  private_dir "$tls_dir"
  if certificate_current; then
    chmod 600 "$tls_dir/tls.key"
    return
  fi
  say "Issuing the certificate for $app_host, $artifact_host, and $registry_host..."
  cat > "$work/leaf.ext" << EOF
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:$app_host, DNS:$artifact_host, DNS:$registry_host
authorityKeyIdentifier = keyid
EOF
  (
    umask 077
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$app_host" \
      -keyout "$tls_dir/tls.key.new" -out "$work/leaf.csr" 2> "$work/openssl.log" &&
      openssl x509 -req -in "$work/leaf.csr" -CA "$ca_dir/ca.pem" -CAkey "$ca_dir/ca-key.pem" \
        -set_serial "0x$(openssl rand -hex 16)" -days 397 -sha256 -extfile "$work/leaf.ext" \
        -out "$tls_dir/tls.crt.new" 2>> "$work/openssl.log"
  ) || fail "OpenSSL could not issue the certificate: $(tail -n 1 "$work/openssl.log")"
  mv "$tls_dir/tls.key.new" "$tls_dir/tls.key"
  mv "$tls_dir/tls.crt.new" "$tls_dir/tls.crt"
}

system_trust_file() {
  if [ "$trust_style" = pki ]; then
    echo "$system_root/etc/pki/ca-trust/source/anchors/everything-local-ca-$1.pem"
  else
    echo "$system_root/usr/local/share/ca-certificates/everything-local-ca-$1.crt"
  fi
}

update_system_trust() {
  if [ "$trust_style" = pki ]; then
    as_root update-ca-trust extract
  else
    as_root update-ca-certificates > /dev/null
  fi
}

# The NSS databases of Chrome, Chromium, and Firefox profiles in this user's home folder. Chrome's
# shared database is created when missing, as Chrome itself would on its first start.
nss_databases() {
  local database
  for database in "$HOME/.pki/nssdb" "$HOME/snap/chromium/current/.pki/nssdb" \
    "$HOME"/.mozilla/firefox/*/ "$HOME"/snap/firefox/common/.mozilla/firefox/*/ \
    "$HOME"/.var/app/org.mozilla.firefox/.mozilla/firefox/*/; do
    database=${database%/}
    if [ -f "$database/cert9.db" ]; then echo "$database"; fi
  done
}

trust_authority() {
  local destination database nickname="$ca_nickname_prefix $ca_fingerprint"
  destination=$(system_trust_file "$ca_fingerprint")
  if put_root_file 0644 "$ca_dir/ca.pem" "$destination"; then
    update_system_trust || fail "Could not update the system certificate store."
  fi
  if [ ! -f "$HOME/.pki/nssdb/cert9.db" ]; then
    (umask 077 && mkdir -p "$HOME/.pki/nssdb")
    certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password ||
      fail "certutil could not create Chrome's certificate database in ~/.pki/nssdb."
  fi
  while IFS= read -r database; do
    if [ -z "$database" ]; then continue; fi
    if certutil -L -d "sql:$database" -n "$nickname" > /dev/null 2>&1; then continue; fi
    certutil -A -d "sql:$database" -t "C,," -n "$nickname" -i "$ca_dir/ca.pem" ||
      fail "certutil could not trust the authority in $database; close that browser and rerun."
  done <<< "$(nss_databases)"
}

# --remove-trust: only files and nicknames this installer names, so other authorities stay trusted.
remove_trust() {
  local file database nickname changed=false
  for file in "$system_root"/usr/local/share/ca-certificates/everything-local-ca-*.crt \
    "$system_root"/etc/pki/ca-trust/source/anchors/everything-local-ca-*.pem; do
    if [ -f "$file" ]; then
      as_root rm -f -- "$file"
      changed=true
      say "Removed $file."
    fi
  done
  if [ "$changed" = true ]; then update_system_trust || fail "Could not update the system certificate store."; fi
  if command -v certutil > /dev/null; then
    while IFS= read -r database; do
      if [ -z "$database" ]; then continue; fi
      # The listing pads each nickname to a column, followed by its trust flags.
      certutil -L -d "sql:$database" 2> /dev/null |
        awk -v prefix="$ca_nickname_prefix" 'index($0, prefix " ") == 1 && $4 ~ /^[0-9a-f]+$/ { print $1, $2, $3, $4 }' |
        while IFS= read -r nickname; do
          certutil -D -d "sql:$database" -n "$nickname" && say "Removed $nickname from $database."
        done
    done <<< "$(nss_databases)"
  fi
  write_hosts false
  say "The local certificate authority is no longer trusted on this computer."
}

# ---------------------------------------------------------------------------------------------------
# Host: the hosts file's block of local names, and k3s's settings.
# ---------------------------------------------------------------------------------------------------

strip_hosts_block() {
  awk -v begin="$hosts_begin" -v end="$hosts_end" '$0 == begin { skip = 1; next } $0 == end { skip = 0; next } !skip'
}

# write_hosts <true|false>: add or remove the block, keeping a dated copy of the file it replaces.
write_hosts() {
  local hosts=$system_root/etc/hosts backup
  if [ -L "$hosts" ]; then fail "/etc/hosts is a symbolic link; the installer will not write through it."; fi
  strip_hosts_block < "$hosts" > "$work/hosts"
  if [ "$1" = true ]; then
    printf '%s\n127.0.0.1\t%s %s %s\n%s\n' "$hosts_begin" "$app_host" "$artifact_host" "$registry_host" \
      "$hosts_end" >> "$work/hosts"
  fi
  if cmp -s "$work/hosts" "$hosts"; then return; fi
  backup=$hosts.everything-local-$(date +%Y%m%d%H%M%S)-$$
  [ ! -e "$backup" ] || fail "$backup already exists."
  as_root cp -p "$hosts" "$backup"
  # Copying onto the file keeps its owner and mode.
  as_root cp "$work/hosts" "$hosts"
  say "Updated /etc/hosts; its previous contents are in $backup."
}

# k3s's settings: the marker that makes this k3s the installer's, the registry's certificate
# authority, and manifests k3s applies itself: Traefik on 127.0.0.1:443, and DNS for the local names.
write_k3s_settings() {
  local config=$system_root/etc/rancher/k3s manifests=$system_root/var/lib/rancher/k3s/server/manifests
  cat > "$work/50-everything-local.yaml" << EOF
$marker
# Traefik serves HTTPS on 127.0.0.1 only, so ServiceLB, which would serve it on every address, is off.
disable:
  - servicelb
EOF
  if put_root_file 0644 "$work/50-everything-local.yaml" "$config/config.yaml.d/50-everything-local.yaml"; then
    k3s_restart=true
  fi
  if put_root_file 0644 "$ca_dir/ca.pem" "$config/everything-local-ca.pem"; then k3s_restart=true; fi
  cat > "$work/registries.yaml" << EOF
$marker
# Nodes pull Everything's images from its registry over HTTPS, trusting the local authority.
configs:
  "$registry_host":
    tls:
      ca_file: /etc/rancher/k3s/everything-local-ca.pem
EOF
  if put_root_file 0644 "$work/registries.yaml" "$config/registries.yaml"; then k3s_restart=true; fi
  # Traefik's chart binds an entrypoint to its port's hostIP, so the entrypoint's address is set back
  # to every address in the pod, where the ClusterIP Service reaches it; only the hostPort is loopback.
  cat > "$work/everything-local-traefik.yaml" << EOF
$marker
# Traefik publishes HTTPS on 127.0.0.1:443 only, and takes registry uploads of any duration. One
# copy holds the host port at a time, so a new one replaces the old instead of starting beside it.
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      type: ClusterIP
    updateStrategy:
      rollingUpdate:
        maxUnavailable: 1
        maxSurge: 0
    ports:
      websecure:
        hostPort: 443
        hostIP: 127.0.0.1
        transport:
          respondingTimeouts:
            readTimeout: 0s
    additionalArguments:
      - --entryPoints.websecure.address=:8443/tcp
EOF
  put_root_file 0600 "$work/everything-local-traefik.yaml" "$manifests/everything-local-traefik.yaml" || true
  # Inside the cluster, the local names lead to Traefik, as public DNS leads a remote cluster's
  # hostnames to its ingress.
  cat > "$work/everything-local-coredns.yaml" << EOF
$marker
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  everything-local.override: |
    rewrite name regex ^(everything|artifacts\.everything|images\.everything)\.internal\.?$ traefik.kube-system.svc.cluster.local. answer auto
EOF
  put_root_file 0600 "$work/everything-local-coredns.yaml" "$manifests/everything-local-coredns.yaml" || true
}

# ---------------------------------------------------------------------------------------------------
# Cluster: k3s, its private kubeconfig, and readiness.
# ---------------------------------------------------------------------------------------------------

start_k3s() {
  if [ "$k3s_state" = fresh ] || [ ! -x "$system_root/usr/local/bin/k3s" ]; then
    download "$k3s_install_url" "$work/k3s-install.sh" "$k3s_install_sha256"
    say "Installing k3s $k3s_version..."
    as_root env INSTALL_K3S_VERSION="$k3s_version" INSTALL_K3S_SYMLINK=skip \
      timeout 900 sh "$work/k3s-install.sh" server ||
      fail "The k3s install script failed; its messages are above."
    return
  fi
  if [ "$k3s_restart" = true ]; then
    say "Restarting k3s with the updated settings..."
    as_root systemctl restart k3s || fail "k3s did not restart; see: sudo journalctl -u k3s"
  elif ! systemctl is-active --quiet k3s; then
    say "Starting k3s..."
    as_root systemctl start k3s || fail "k3s did not start; see: sudo journalctl -u k3s"
  fi
}

# Copy k3s's admin kubeconfig to a file only this user reads, named for this cluster, so commands
# never fall back to ~/.kube/config or its current context.
write_kubeconfig() {
  local source=$system_root/etc/rancher/k3s/k3s.yaml
  wait_until 300 "k3s to write its kubeconfig" as_root test -s "$source"
  (
    umask 077
    as_root cat "$source" | sed \
      -e "s/^\([ -]*\)name: default$/\1name: $context_name/" \
      -e "s/^\( *\)cluster: default$/\1cluster: $context_name/" \
      -e "s/^\( *\)user: default$/\1user: $context_name/" \
      -e "s/^current-context: default$/current-context: $context_name/" > "$kubeconfig.new"
  ) || fail "Could not read k3s's kubeconfig."
  grep -qx "current-context: $context_name" "$kubeconfig.new" ||
    fail "k3s's kubeconfig has an unexpected layout; nothing else was changed."
  chmod 600 "$kubeconfig.new"
  mv "$kubeconfig.new" "$kubeconfig"
  if command -v kubectl > /dev/null; then
    kubectl_bin=$(command -v kubectl)
  else
    # k3s's binary acts as kubectl when it runs by that name.
    ln -sfn "$system_root/usr/local/bin/k3s" "$bin_dir/kubectl"
    kubectl_bin=$bin_dir/kubectl
  fi
}

# One deadline bounds the whole wait.
wait_for_cluster() {
  local deadline
  deadline=$(($(date +%s) + cluster_timeout))
  say "Waiting for the cluster, Traefik, and DNS..."
  wait_until "$(remaining "$deadline")" "the Kubernetes API" kc_check get --raw=/readyz
  wait_until "$(remaining "$deadline")" "the node" kc_check wait --for=condition=Ready node --all --timeout=10s
  wait_until "$(remaining "$deadline")" "CoreDNS" kc_check -n kube-system rollout status deployment/coredns --timeout=10s
  wait_until "$(remaining "$deadline")" "the local DNS names" kc_check -n kube-system get configmap coredns-custom
  wait_until "$(remaining "$deadline")" "Traefik" kc_check -n kube-system rollout status deployment/traefik --timeout=10s
  wait_until "$(remaining "$deadline")" "Traefik's loopback port" traefik_on_loopback
}

# Seconds left until a deadline, at least one.
remaining() {
  local left=$(($1 - $(date +%s)))
  if [ "$left" -lt 1 ]; then left=1; fi
  echo "$left"
}

# The running Traefik publishes 443 on 127.0.0.1 alone.
traefik_on_loopback() {
  [ "$(kc_check -n kube-system get deployment traefik -o \
    'jsonpath={range .spec.template.spec.containers[*].ports[?(@.hostPort==443)]}{.hostIP}{end}')" = 127.0.0.1 ]
}

# The release's namespace, admitting Everything's privileged Docker sidecar as install.sh's does,
# with the certificate Traefik serves and the authority's public certificate for Fleet and Docker.
write_cluster_secrets() {
  local hash
  kc apply -f - > /dev/null << EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    pod-security.kubernetes.io/enforce: privileged
EOF
  kc -n "$namespace" create secret tls "$tls_secret" --cert "$tls_dir/tls.crt" --key "$tls_dir/tls.key" \
    --dry-run=client -o yaml | kc apply -f - > /dev/null
  # OpenSSL finds certificates in a folder by their subject hash; Go and Docker read every file.
  hash=$(openssl x509 -in "$ca_dir/ca.pem" -noout -subject_hash)
  kc -n "$namespace" create secret generic "$ca_secret" --from-file "ca.crt=$ca_dir/ca.pem" \
    --from-file "$hash.0=$ca_dir/ca.pem" --dry-run=client -o yaml | kc apply -f - > /dev/null
}

# ---------------------------------------------------------------------------------------------------
# Everything: the regular installer, with the local answers preset.
# ---------------------------------------------------------------------------------------------------

write_preset() {
  local site
  {
    echo "# namespace: $namespace"
    echo "global:"
    echo "  externalHostname: '$app_host'"
    echo "  externalArtifactHostname: '$artifact_host'"
    echo "  externalRegistryHostname: '$registry_host'"
    for site in ingress artifactIngress registryIngress; do
      echo "  $site:"
      echo "    className: 'traefik'"
      echo "    annotations:"
      echo "      traefik.ingress.kubernetes.io/router.entrypoints: 'websecure'"
      echo "    tlsSecretName: '$tls_secret'"
    done
    echo "  storageClassName: 'local-path'"
    # fleetd's registry client is Go, which reads the extra folder beside the system's, and Docker
    # trusts a registry's authority from its folder under certs.d.
    echo "services:"
    echo "  everything:"
    echo "    env:"
    echo "      SSL_CERT_DIR: '/etc/ssl/certs:/etc/everything-local-ca'"
    echo "    volumes:"
    echo "      local-ca:"
    echo "        mountPath: '/etc/everything-local-ca'"
    echo "        secret: '$ca_secret'"
    echo "    sidecars:"
    echo "      docker:"
    echo "        volumeMounts:"
    echo "          local-ca: '/etc/docker/certs.d/$registry_host'"
    # The speech service for voice input runs only on x86-64 nodes.
    if [ "$arch" = arm64 ]; then
      echo "  voice-asr:"
      echo "    enabled: false"
    fi
  } > "$work/preset.yaml"
}

run_installer() {
  local status=0 version=${EVERYTHING_VERSION:-}
  if [ -n "$release_version" ]; then version=$release_version; fi
  say ""
  say "Starting Everything's installer. Its cluster, hostnames, ingress, TLS, and storage are already"
  say "set for this computer; it asks for the rest."
  say ""
  env KUBECONFIG="$kubeconfig" PATH="$bin_dir:$(dirname "$helm_bin"):$PATH" \
    EVERYTHING_VERSION="$version" EVERYTHING_SETTINGS_FILE="$state_dir/everything-values.yaml" \
    EVERYTHING_PRESET_SETTINGS="$work/preset.yaml" bash "$installer" < /dev/null || status=$?
  if [ "$status" -ne 0 ]; then fail "Everything's installer stopped with status $status."; fi
  if ! "$helm_bin" status "$release" --kubeconfig "$kubeconfig" --kube-context "$context_name" \
    --namespace "$namespace" > /dev/null 2>&1; then
    say "Everything is not installed; rerun the installer to continue."
    finished=true
    exit 0
  fi
}

wait_for_everything() {
  local workload deadline
  say ""
  say "Waiting for Everything to start, which takes several minutes on a new installation..."
  deadline=$(($(date +%s) + everything_timeout))
  for workload in $(kc -n "$namespace" get deployments,statefulsets -o name); do
    kc -n "$namespace" rollout status "$workload" --timeout="$(remaining "$deadline")s" > /dev/null ||
      fail "$workload is not ready; see: KUBECONFIG=$kubeconfig kubectl -n $namespace get pods"
  done
}

# Each name answers over HTTPS with the trusted certificate, as a browser on this computer sees it.
verify_endpoints() {
  local url code
  for url in "https://$app_host/health/ready" "https://$artifact_host/" "https://$registry_host/v2/"; do
    code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 20 "$url") ||
      fail "$url did not answer with a trusted certificate."
    case "$url:$code" in
      */health/ready:200 | */v2/:401 | "https://$artifact_host/":[2345]??) ;;
      *) fail "$url answered HTTP $code." ;;
    esac
  done
}

print_summary() {
  say ""
  say "Everything is running on this computer."
  say "  Open https://$app_host and sign in with the user you created."
  say "  Apps your teammates make open on https://$artifact_host."
  say "  Browsers that were open during the installation may need a restart to trust the certificate."
  if [ "$arch" = arm64 ]; then
    say "  Voice input is off: its speech service runs only on x86-64 computers."
  fi
  say "  Cluster commands: KUBECONFIG=$kubeconfig kubectl -n $namespace get pods"
  say "  Rerun this installer to upgrade, repair, or create the first user; it keeps your settings in"
  say "  $state_dir/everything-values.yaml."
}

cleanup() {
  local status=$?
  stty echo <&3 2> /dev/null || true
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  # Descriptor 4 is the terminal's error output, which a signal's trap may run without, inside a
  # command whose output is discarded.
  if [ "$status" -ne 0 ] && [ "$finished" = false ] && [ -n "$phase" ]; then
    {
      echo ""
      echo "The installer stopped while $phase. What it finished is kept; fix the problem above and"
      echo "rerun it to continue. It does not remove k3s, data, or trust on failure; see --help to remove them."
    } >&4
  fi
  return "$status"
}

main() {
  local remove=false
  while [ $# -gt 0 ]; do
    case $1 in
      --installer)
        [ $# -ge 2 ] || fail "--installer needs a file."
        installer=$2
        shift 2
        ;;
      --remove-trust)
        remove=true
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) fail "Unknown option $1; see --help." ;;
    esac
  done
  if ! (: < /dev/tty) 2> /dev/null; then
    fail "The installer asks questions; run it from a terminal."
  fi
  exec 3< /dev/tty 4>&2
  work=$(mktemp -d "${TMPDIR:-/tmp}/everything-k3s.XXXXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  phase="checking this computer"
  check_platform
  check_user
  check_tools
  check_state
  if [ "$remove" = true ]; then
    remove_trust
    finished=true
    return
  fi
  choose_installer
  check_resources
  check_k3s
  check_ports
  check_hosts
  explain_plan

  phase="installing tools"
  install_packages
  private_dir "$state_dir"
  private_dir "$bin_dir"
  choose_helm
  fetch_installer
  phase="creating certificates"
  make_authority
  make_certificate
  trust_authority
  phase="configuring this computer"
  write_hosts true
  write_k3s_settings
  phase="starting k3s"
  start_k3s
  write_kubeconfig
  wait_for_cluster
  write_cluster_secrets
  phase="installing Everything"
  write_preset
  run_installer
  phase="waiting for Everything"
  wait_for_everything
  verify_endpoints
  finished=true
  print_summary
}

# Everything runs from here, so a partial download runs nothing.
main "$@"
