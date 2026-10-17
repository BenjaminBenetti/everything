#!/usr/bin/env bash
# Install or upgrade Everything on a Kubernetes cluster from its published Helm chart:
#   curl -fsSL https://github.com/BenjaminBenetti/everything/releases/latest/download/install.sh | bash
# It asks for the installation's settings, credentials, and disk sizes, saves them in a values file
# that later runs reuse, asking again only for what that file lacks, creates the release's namespace,
# runs `helm upgrade --install`, which also keeps the settings in the cluster so Everything can upgrade
# itself, and offers to create the first user while Keycloak has none. It needs
# Helm 3.8 or newer, kubectl, and a kubectl context selecting the target cluster. It runs on Bash 3.2,
# as macOS ships.
set -euo pipefail

# The version installed by default; the release workflow sets it in the copy it publishes. Empty
# selects the newest stable chart in the registry.
release_version=""
chart=oci://ghcr.io/benjaminbenetti/everything/charts/everything
release=everything
default_settings_file=everything-values.yaml
# Runs Keycloak's admin CLI, which creates the first user inside the cluster.
keycloak_workload=deployment/keycloak

hostname_pattern='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
# Namespaces for apps, builds, and Fleet append up to 10 characters to the release's namespace.
namespace_pattern='^[a-z0-9]([a-z0-9-]{0,51}[a-z0-9])?$'
session_key_pattern='^[A-Za-z0-9+/]{43}=$'
# Keycloak lowercases usernames; the application accepts up to 254 characters.
username_pattern='^[a-z0-9][a-z0-9._@-]{0,253}$'
# A Kubernetes storage quantity, such as 20Gi.
size_pattern='^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$'
# Separates the keys of a setting's path in the settings entries.
path_separator=$'\037'

# Answers and working state, set as the installer runs.
settings_file="" reuse=false settings_changed=false version="" namespace=""
work="" package="" chart_dir="" entries="" context="" first_install=false section=""
new_username="" new_password="" first_user=""

# ---------------------------------------------------------------------------------------------------
# Terminal: prompts read the terminal on descriptor 3, because curl's output is the shell's input.
# ---------------------------------------------------------------------------------------------------

say() { printf '%s\n' "$*" >&2; }
fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

# Read one line from the terminal into the named variable.
read_line() {
  IFS= read -r "$@" <&3 || fail "The installer stopped reading answers; run it from a terminal."
}

# The prompt functions below set the caller's variable by name, so their own locals carry a prefix
# no caller uses; a caller's variable of the same name would otherwise be hidden from them.

# ask <variable> <prompt> [default]: a line from the terminal, or the default when it is empty.
ask() {
  local ask_reply
  if [ -n "${3:-}" ]; then printf '%s [%s]: ' "$2" "$3" >&2; else printf '%s: ' "$2" >&2; fi
  read_line ask_reply
  printf -v "$1" '%s' "${ask_reply:-${3:-}}"
}

# ask_hidden <variable> <prompt>: a line from the terminal without echoing it.
ask_hidden() {
  local ask_reply
  printf '%s: ' "$2" >&2
  read_line -s ask_reply
  printf '\n' >&2
  printf -v "$1" '%s' "$ask_reply"
}

# confirm <prompt> <Y|N>: succeed on yes; the second argument is the answer Enter gives.
confirm() {
  local ask_reply ask_hint=y/N
  if [ "$2" = Y ]; then ask_hint=Y/n; fi
  while true; do
    printf '%s [%s]: ' "$1" "$ask_hint" >&2
    read_line ask_reply
    case "${ask_reply:-$2}" in
      [Yy] | [Yy][Ee][Ss]) return 0 ;;
      [Nn] | [Nn][Oo]) return 1 ;;
    esac
  done
}

# begin_section <title> [note]: introduce a group of questions before its first one; on a rerun,
# say first why the installer asks anything at all.
begin_section() {
  if [ "$section" = "$1" ]; then return; fi
  if [ "$reuse" = true ] && [ -z "$section" ]; then
    say ""
    say "Your settings file lacks some settings this version uses; the rest are kept."
  fi
  section=$1
  say ""
  say "$1"
  if [ -n "${2:-}" ]; then say "$2"; fi
}

lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------------------------------------------------------------------------------------------------
# Settings entries: the settings file is a Helm values file of nested maps and quoted scalars, held
# while the installer runs as `<path><TAB><value as written>` lines, where the path joins the keys
# with the unit separator. New answers join their place in the tree when the file is written.
# ---------------------------------------------------------------------------------------------------

# A YAML single-quoted scalar.
yaml_quote() {
  local quote="'"
  printf "'%s'" "${1//$quote/$quote$quote}"
}

# A JSON string; prompts yield no newlines, and tabs are escaped. Quoting each part keeps the
# replacements literal in every Bash version.
json_string() {
  local value=$1 backslash="\\" quote='"' tab=$'\t'
  value=${value//"$backslash"/"$backslash$backslash"}
  value=${value//"$quote"/"$backslash$quote"}
  value=${value//"$tab"/"${backslash}t"}
  printf '"%s"' "$value"
}

# A random 32-character password of letters and digits.
random_password() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c 1-32; }

# 32 random bytes in base64, the session encryption key's format.
random_session_key() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# A setting's path from its keys.
key_path() {
  local IFS=$path_separator
  printf '%s' "$*"
}

# The entries of a values file of nested maps, skipping comments and blank lines.
flatten_values() {
  awk -v separator="$path_separator" '
    /^[ ]*#/ || /^[ ]*$/ { next }
    {
      match($0, /^ */)
      indent = RLENGTH
      line = substr($0, indent + 1)
      if (line ~ /:$/) {
        key = substr(line, 1, length(line) - 1)
        parent = 1
      } else {
        split_at = index(line, ": ")
        if (!split_at) next
        key = substr(line, 1, split_at - 1)
        value = substr(line, split_at + 2)
        parent = 0
      }
      while (depth > 0 && indents[depth] >= indent) depth--
      path = ""
      for (level = 1; level <= depth; level++) path = path keys[level] separator
      if (parent) {
        depth++
        indents[depth] = indent
        keys[depth] = key
      } else {
        print path key "\t" value
      }
    }
  ' "$1"
}

# A values file from entries, nesting each key under its parent in the order keys first appear.
unflatten_values() {
  awk -F '\t' -v separator="$path_separator" '
    {
      count_parts = split($1, parts, separator)
      parent = ""
      for (level = 1; level <= count_parts; level++) {
        node = level == 1 ? parts[1] : parent separator parts[level]
        if (!(node in name)) {
          name[node] = parts[level]
          children[parent] = children[parent] + 1
          child[parent, children[parent]] = node
        }
        parent = node
      }
      value[$1] = substr($0, length($1) + 2)
    }
    function emit(node, depth,    i, entry, pad) {
      pad = ""
      for (i = 0; i < depth; i++) pad = pad "  "
      for (i = 1; i <= children[node]; i++) {
        entry = child[node, i]
        if (children[entry] > 0) {
          print pad name[entry] ":"
          emit(entry, depth + 1)
        } else {
          print pad name[entry] ": " value[entry]
        }
      }
    }
    END { emit("", 0) }
  ' "$1"
}

# has_entry <key>...: succeed when the settings hold that setting.
has_entry() {
  ENTRY_PATH=$(key_path "$@") awk -F '\t' '
    $1 == ENVIRON["ENTRY_PATH"] { found = 1; exit }
    END { exit !found }
  ' "$entries"
}

# setting <key>...: a setting's value, unquoted; empty when the settings lack it.
setting() {
  local raw quote="'"
  raw=$(ENTRY_PATH=$(key_path "$@") awk -F '\t' '
    $1 == ENVIRON["ENTRY_PATH"] { print substr($0, length($1) + 2); exit }
  ' "$entries")
  case $raw in
    \'*\')
      raw=${raw#\'}
      raw=${raw%\'}
      raw=${raw//$quote$quote/$quote}
      ;;
    \"*\")
      raw=${raw#\"}
      raw=${raw%\"}
      ;;
  esac
  printf '%s' "$raw"
}

# set_entry <value as written> <key>...: add or replace a setting.
set_entry() {
  local value=$1
  shift
  ENTRY_PATH=$(key_path "$@") ENTRY_VALUE=$value awk -F '\t' '
    $1 == ENVIRON["ENTRY_PATH"] { if (!done) print $1 "\t" ENVIRON["ENTRY_VALUE"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["ENTRY_PATH"] "\t" ENVIRON["ENTRY_VALUE"] }
  ' "$entries" > "$entries.next"
  mv "$entries.next" "$entries"
  settings_changed=true
}

# The settings as a values file.
render_settings() {
  echo "# Everything's installation settings and credentials, written by install.sh. Keep this file"
  echo "# private. Later runs of the installer reuse it and ask only for what it lacks; they rewrite it,"
  echo "# so keep its plain layout of nested keys and quoted values. Changing a database password here"
  echo "# after the first installation does not change it inside PostgreSQL."
  echo "# namespace: $namespace"
  unflatten_values "$entries"
}

# `<secret><TAB><key>` for each credential under `secrets` in the chart's values.
chart_credentials() {
  awk '
    /^secrets:/ { inside = 1; next }
    inside && /^[^ #]/ { exit }
    inside && /^  [a-z0-9-]+:[ ]*$/ { secret = $1; sub(/:$/, "", secret); next }
    inside && /^    [a-z0-9-]+:/ { key = $1; sub(/:$/, "", key); print secret "\t" key }
  ' "$chart_dir/values.yaml"
}

# `<claim><TAB><service><TAB><size>` for each disk the chart claims with the current settings; a
# shared volume's claim names no service.
chart_disks() {
  render_settings > "$work/current.yaml"
  helm template "$release" "$package" --namespace "$namespace" \
    --values "$chart_dir/values.prod.yaml" --values "$work/current.yaml" \
    --show-only templates/persistent-volume-claims.yaml | awk '
      function emit() { if (claim != "") print claim "\t" service "\t" size }
      /^---/ { emit(); claim = service = size = "" }
      /^  name: / { claim = $2 }
      /^    app\.kubernetes\.io\/name: / { service = $2 }
      /^      storage: / { size = $2; gsub(/"/, "", size) }
      END { emit() }
    '
}

# ---------------------------------------------------------------------------------------------------
# Questions: each answer has its place in the values, and is asked for only while the settings lack
# it, so new settings ask everything and saved ones only what a newer installer or chart added.
# ---------------------------------------------------------------------------------------------------

choose_settings_file() {
  ask settings_file "Settings file, kept for later upgrades" "$default_settings_file"
  reuse=false
  if [ -f "$settings_file" ]; then
    if confirm "Use the saved settings in $settings_file?" Y; then
      reuse=true
      return
    fi
    confirm "Replace $settings_file with new settings?" N ||
      fail "Nothing changed. Run the installer again and choose another settings file."
  fi
}

choose_version() {
  local latest=${EVERYTHING_VERSION:-$release_version}
  if [ -z "$latest" ]; then
    latest=$(helm show chart "$chart" 2> /dev/null | sed -n 's/^version: *//p' || true)
  fi
  ask version "Version to install" "$latest"
  version=${version#v}
  [ -n "$version" ] ||
    fail "Choose a version from https://github.com/BenjaminBenetti/everything/releases."
}

ask_namespace() {
  while true; do
    ask namespace "Namespace to install into" everything
    namespace=$(lowercase "$namespace")
    if [[ $namespace =~ $namespace_pattern ]]; then return; fi
    say "Use lowercase letters, digits, and hyphens, at most 53 characters."
  done
}

# Start from the saved settings, or from none.
load_settings() {
  entries=$work/entries
  : > "$entries"
  if [ "$reuse" = true ]; then
    flatten_values "$settings_file" > "$entries"
    namespace=$(sed -n 's/^# namespace: *//p' "$settings_file" | head -n 1)
  fi
  if [ -z "$namespace" ]; then
    begin_section "Cluster settings"
    ask_namespace
  fi
}

# Find the target cluster, and whether the release is already installed there.
resolve_cluster() {
  context=$(kubectl config current-context 2> /dev/null) ||
    fail "kubectl has no current context; select the target cluster first."
  if helm status "$release" --kube-context "$context" --namespace "$namespace" > /dev/null 2>&1; then
    first_install=false
  else
    first_install=true
  fi
}

# ask_hostname <variable> <prompt> [default]
ask_hostname() {
  local answer
  while true; do
    ask answer "$2" "${3:-}"
    answer=$(lowercase "$answer")
    if [[ $answer =~ $hostname_pattern ]]; then break; fi
    say "Enter a hostname such as everything.example.com."
  done
  printf -v "$1" '%s' "$answer"
}

ask_hostnames() {
  local app_host artifact_host registry_host domain
  if ! has_entry global externalHostname; then
    begin_section "Cluster settings"
    ask_hostname app_host "Hostname the application is served on, such as everything.example.com"
    set_entry "$(yaml_quote "$app_host")" global externalHostname
  fi
  app_host=$(setting global externalHostname)
  # Siblings of the application's hostname share its domain, as the app host's login cookie needs.
  case $app_host in
    *.*.*) domain=${app_host#*.} ;;
    *) domain=$app_host ;;
  esac
  if ! has_entry global externalArtifactHostname; then
    begin_section "Cluster settings"
    while true; do
      ask_hostname artifact_host "Hostname for apps, another name on the same domain" "artifacts.$domain"
      if [ "$artifact_host" != "$app_host" ]; then break; fi
      say "Apps need a hostname of their own."
    done
    set_entry "$(yaml_quote "$artifact_host")" global externalArtifactHostname
  fi
  artifact_host=$(setting global externalArtifactHostname)
  if ! has_entry global externalRegistryHostname; then
    begin_section "Cluster settings"
    while true; do
      ask_hostname registry_host "Hostname of the image registry nodes pull from" "images.$domain"
      if [ "$registry_host" != "$app_host" ] && [ "$registry_host" != "$artifact_host" ]; then break; fi
      say "The registry needs a hostname of its own."
    done
    set_entry "$(yaml_quote "$registry_host")" global externalRegistryHostname
  fi
}

# The ingress class, TLS issuer, and storage class. Each is written even when left to the cluster's
# default, so a later run knows it was answered.
ask_cluster_classes() {
  local ingress_class issuer storage_class site
  if ! has_entry global ingress className; then
    begin_section "Cluster settings"
    ask ingress_class "Name of the ingress class to use (Enter for the cluster's default)"
    for site in ingress artifactIngress registryIngress; do
      set_entry "$(yaml_quote "$ingress_class")" global "$site" className
    done
    # ingress-nginx limits request bodies, and the registry receives whole image layers.
    case $ingress_class in
      *nginx*) set_entry "'0'" global registryIngress annotations nginx.ingress.kubernetes.io/proxy-body-size ;;
    esac
  fi
  if ! has_entry global ingress tlsSecretName; then
    begin_section "Cluster settings"
    ask issuer "Name of the cert-manager ClusterIssuer to use for TLS (Enter if your ingress handles TLS)"
    # With an issuer, cert-manager fills each Ingress's TLS Secret; an empty name leaves TLS to the
    # ingress controller.
    for site in ingress:everything-tls artifactIngress:everything-artifacts-tls \
      registryIngress:everything-registry-tls; do
      if [ -n "$issuer" ]; then
        set_entry "$(yaml_quote "$issuer")" global "${site%%:*}" annotations cert-manager.io/cluster-issuer
        set_entry "'${site#*:}'" global "${site%%:*}" tlsSecretName
      else
        set_entry "''" global "${site%%:*}" tlsSecretName
      fi
    done
  fi
  if ! has_entry global storageClassName; then
    begin_section "Cluster settings"
    ask storage_class "Name of the storage class to use (Enter for the cluster's default)"
    set_entry "$(yaml_quote "$storage_class")" global storageClassName
  fi
}

# credential <secret> <key>: print the value for one of the chart's credentials.
credential() {
  local secret=$1 key=$2 description value
  if [ "$secret.$key" = registry-credentials.username ]; then
    ask value "Image registry username" everything
    printf '%s' "$value"
    return
  fi
  case "$secret.$key" in
    database-credentials.admin) description="PostgreSQL superuser password" ;;
    database-credentials.*) description="PostgreSQL password of the $key database" ;;
    keycloak-credentials.admin) description="Keycloak admin password, used only inside the cluster" ;;
    browser-auth.client-secret) description="Client secret Everything signs users in to Keycloak with" ;;
    browser-auth.session-encryption-key) description="Session encryption key, 32 random bytes in base64" ;;
    artifact-auth.client-secret) description="Client secret Everything calls the app service with" ;;
    app-provisioner-auth.client-secret) description="Client secret the app service registers apps with" ;;
    registry-credentials.password) description="Image registry password" ;;
    *) description="Value of secrets.$secret.$key" ;;
  esac
  while true; do
    ask_hidden value "$description (Enter to generate one)"
    if [ "$secret.$key" = browser-auth.session-encryption-key ]; then
      value=${value:-$(random_session_key)}
      if [[ ! $value =~ $session_key_pattern ]]; then
        say "The key must be 32 bytes in base64: 43 characters followed by '='."
        continue
      fi
    fi
    value=${value:-$(random_password)}
    case $value in
      *$'\t'*) say "Use a value without tabs." ;;
      *) break ;;
    esac
  done
  printf '%s' "$value"
}

# Ask for every credential the chart declares that the settings lack.
ask_credentials() {
  local secret key value
  while IFS=$'\t' read -r secret key; do
    if has_entry secrets "$secret" "$key"; then continue; fi
    begin_section "Credentials" \
      "Press Enter to generate a random value; every value is saved in the settings file."
    # A plain assignment, so a failed prompt stops the installer instead of saving an empty value.
    value=$(credential "$secret" "$key")
    set_entry "$(yaml_quote "$value")" secrets "$secret" "$key"
  done <<< "$(chart_credentials)"
}

# What a disk holds, in the terms people know the product by.
disk_description() {
  case $1 in
    postgres-data) echo "the database: conversations, settings, and the data of apps your teammates make" ;;
    everything-agents) echo "teammates' files and the folder they share" ;;
    everything-fleet) echo "workspaces, where teammates work on complex, long-running tasks such as building apps" ;;
    registry-data) echo "the app and workspace images your teammates build" ;;
    artifact-content) echo "the apps your teammates make in Everything" ;;
    *) echo "the $1 volume" ;;
  esac
}

# A size in MiB, for sizes in binary units; nothing for others, which are not compared.
size_in_mib() {
  local number=${1%[KMGTPE]i} unit=${1#"${1%[KMGTPE]i}"}
  case $number in '' | *[!0-9]*) return ;; esac
  case $unit in
    Ki) echo $((number / 1024)) ;;
    Mi) echo "$number" ;;
    Gi) echo $((number * 1024)) ;;
    Ti) echo $((number * 1024 * 1024)) ;;
    Pi) echo $((number * 1024 * 1024 * 1024)) ;;
  esac
}

# Ask for each disk's size that the settings lack, offering an existing disk's size, or else the
# chart's, and refusing to shrink an existing disk.
ask_disk_sizes() {
  local disks claim service size current answer note key requested existing
  disks=$(chart_disks) || fail "Could not read the chart's disks."
  note="Use Kubernetes sizes such as 20Gi. Disks never shrink, and growing one later needs a storage class that allows volume expansion."
  while IFS=$'\t' read -r claim service size; do
    if [ -z "$claim" ]; then continue; fi
    # Everything's own state, provider logins and caches, stays far below the chart's size.
    if [ "$claim" = everything-state ]; then continue; fi
    if [ -n "$service" ]; then
      key="services $service volumes ${claim#"$service"-} persistentVolume size"
    else
      key="sharedVolumes $claim size"
    fi
    # shellcheck disable=SC2086 # The key's words are its path.
    if has_entry $key; then continue; fi
    current=""
    if [ "$first_install" = false ]; then
      current=$(kubectl --context "$context" --namespace "$namespace" get pvc "$claim" \
        -o 'jsonpath={.spec.resources.requests.storage}' < /dev/null 2> /dev/null || true)
    fi
    begin_section "Disk sizes" "$note"
    while true; do
      ask answer "Size of the disk for $(disk_description "$claim") (PVC $claim)" "${current:-$size}"
      if [[ ! $answer =~ $size_pattern ]]; then
        say "Enter a size such as 20Gi."
        continue
      fi
      requested=$(size_in_mib "$answer")
      existing=$(size_in_mib "$current")
      if [ -n "$requested" ] && [ -n "$existing" ] && [ "$requested" -lt "$existing" ]; then
        say "This disk already holds $current, and disks never shrink."
        continue
      fi
      break
    done
    # shellcheck disable=SC2086 # The key's words are its path.
    set_entry "$(yaml_quote "$answer")" $key
  done <<< "$disks"
}

save_settings() {
  if [ "$reuse" = true ] && [ "$settings_changed" = false ]; then return; fi
  render_settings > "$work/settings.yaml"
  (
    umask 077
    cat "$work/settings.yaml" > "$settings_file"
  )
  chmod 600 "$settings_file"
  say ""
  say "Saved the settings to $settings_file. It holds credentials, so keep it private."
}

# ---------------------------------------------------------------------------------------------------
# Installation.
# ---------------------------------------------------------------------------------------------------

# Download the chart once: its values declare the credentials, its production values sit under the
# settings file, and it renders the disks.
fetch_chart() {
  say "Downloading version $version of the chart..."
  helm pull "$chart" --version "$version" --destination "$work" > /dev/null ||
    fail "Could not download version $version of the chart."
  package=$(printf '%s\n' "$work"/*.tgz | head -n 1)
  chart_dir=$work/chart
  mkdir "$chart_dir"
  tar -xzf "$package" -C "$chart_dir" --strip-components 1
}

install_release() {
  local action="Install Everything $version into namespace $namespace"
  if [ "$first_install" = false ]; then action="Upgrade Everything in namespace $namespace to $version"; fi
  say ""
  if ! confirm "$action with kubectl context $context?" Y; then
    say "Nothing installed. Run the installer again to reuse $settings_file."
    exit 0
  fi
  # The release's namespace admits Everything's privileged Docker sidecar; the chart creates the
  # namespaces its services run workloads in.
  kubectl --context "$context" apply -f - > /dev/null << EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    pod-security.kubernetes.io/enforce: privileged
EOF
  # The settings also go into the cluster, so Everything can upgrade itself with them later. Helm's
  # --set-file splits on commas, so it reads a copy at a path without any.
  cp "$settings_file" "$work/upgrade-settings.yaml"
  helm upgrade "$release" "$package" --install --kube-context "$context" --namespace "$namespace" \
    --values "$chart_dir/values.prod.yaml" --values "$settings_file" \
    --set-file "upgrades.settings=$work/upgrade-settings.yaml"
}

# ---------------------------------------------------------------------------------------------------
# First user: Keycloak's admin console is not exposed, so the installer creates the first person's
# account through Keycloak's admin CLI inside its pod.
# ---------------------------------------------------------------------------------------------------

# Run Keycloak's admin CLI in its pod on the application's realm, signed in as the bootstrap admin
# from the pod's own environment, so that password never leaves the cluster. Standard input passes
# through.
keycloak_admin() {
  # shellcheck disable=SC2016 # The pod's shell expands these.
  kubectl --context "$context" --namespace "$namespace" exec -i "$keycloak_workload" -- bash -c \
    'exec /opt/keycloak/bin/kcadm.sh "$@" -r "$EVERYTHING_REALM" --no-config \
      --server http://localhost:8080/auth --realm master \
      --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"' kcadm "$@"
}

ask_username() {
  while true; do
    ask new_username "Username"
    new_username=$(lowercase "$new_username")
    if [[ $new_username =~ $username_pattern ]]; then return; fi
    say "Use letters, digits, and . _ @ -, starting with a letter or digit."
  done
}

# The first user's password, typed twice. It is not saved anywhere but Keycloak.
ask_new_password() {
  local confirmation
  while true; do
    ask_hidden new_password "Password (at least 8 characters)"
    case $new_password in
      *[[:cntrl:]]*)
        say "Use printable characters only."
        continue
        ;;
    esac
    if [ ${#new_password} -lt 8 ] || [ ${#new_password} -gt 1024 ]; then
      say "Use 8 to 1024 characters."
      continue
    fi
    ask_hidden confirmation "Password again"
    if [ "$new_password" = "$confirmation" ]; then return; fi
    say "The passwords differ; try again."
  done
}

# Offer to create the first user while the realm has none: after a new installation, or on a later
# run when the first attempt did not finish.
setup_first_user() {
  local users output
  say ""
  say "Waiting for Keycloak, which takes a few minutes on a new installation..."
  if ! kubectl --context "$context" --namespace "$namespace" rollout status "$keycloak_workload" \
    --timeout=15m > /dev/null; then
    say "Keycloak is not ready yet. Run the installer again once it is to create your first user."
    return
  fi
  if ! users=$(keycloak_admin get users -q max=1 --fields id < /dev/null 2> /dev/null); then
    say "Could not list Keycloak's users. Run the installer again to create your first user."
    return
  fi
  case $users in *'"id"'*) return ;; esac
  say ""
  if [ "$first_install" = true ]; then
    say "Installed. Let's set up your first user."
  else
    say "Everything has no users yet. Let's set up the first one."
  fi
  if ! confirm "Create the first user now?" Y; then
    say "Run the installer again any time to create it."
    return
  fi
  while true; do
    ask_username
    ask_new_password
    # The password reaches Keycloak only on standard input, never on a command line.
    output=$(printf '{"username":%s,"enabled":true,"credentials":[{"type":"password","value":%s,"temporary":false}]}' \
      "$(json_string "$new_username")" "$(json_string "$new_password")" |
      keycloak_admin create users -f - 2>&1) || true
    new_password=""
    case $output in
      *"Created new user"*)
        first_user=$new_username
        say "Created $first_user."
        return
        ;;
    esac
    say "Keycloak did not create the user: $(printf '%s\n' "$output" | grep -v '^Logging into' | tail -n 1)"
    confirm "Try again?" Y || return
  done
}

print_next_steps() {
  local app_host
  app_host=$(setting global externalHostname)
  say ""
  if [ "$first_install" = true ]; then
    say "Everything $version is installed in namespace $namespace."
    say "  Point DNS for $app_host, $(setting global externalArtifactHostname), and"
    say "  $(setting global externalRegistryHostname) at your ingress controller."
  else
    say "Everything is upgraded to $version in namespace $namespace."
  fi
  say "  Watch its pods: kubectl -n $namespace get pods -w"
  if [ -n "$first_user" ]; then
    say "  Sign in at https://$app_host as $first_user."
  else
    say "  Sign in at https://$app_host."
  fi
  say "  To upgrade, open Settings in Everything, or run the installer again and reuse $settings_file."
}

cleanup() {
  stty echo <&3 2> /dev/null || true
  rm -rf "$work"
}

main() {
  if ! (: < /dev/tty) 2> /dev/null; then
    fail "The installer asks questions; run it from a terminal."
  fi
  exec 3< /dev/tty
  local tool
  for tool in helm kubectl tar; do
    command -v "$tool" > /dev/null || fail "$tool is required."
  done
  work=$(mktemp -d)
  trap cleanup EXIT

  say "Everything installer: installs or upgrades Everything with Helm."
  say ""
  choose_settings_file
  choose_version
  fetch_chart
  load_settings
  resolve_cluster
  ask_hostnames
  ask_cluster_classes
  ask_credentials
  # The disks render from the chart, which needs the settings and credentials above.
  ask_disk_sizes
  save_settings
  install_release
  setup_first_user
  print_next_steps
}

# Everything runs from here, so a partial download runs nothing.
main "$@"
