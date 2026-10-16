#!/usr/bin/env bash
# Install or upgrade Everything on a Kubernetes cluster from its published Helm chart:
#   curl -fsSL https://github.com/BenjaminBenetti/everything/releases/latest/download/install.sh | bash
# It asks for the installation's settings and credentials, saves them in a values file that later runs
# reuse, creates the release's namespace, runs `helm upgrade --install`, and offers to create the first
# user while Keycloak has none. It needs Helm 3.8 or newer, kubectl, and a kubectl context selecting the
# target cluster. It runs on Bash 3.2, as macOS ships.
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

# Answers and working state, set as the installer runs.
settings_file="" reuse=false credentials_changed=false version="" namespace=""
app_host="" artifact_host="" registry_host="" ingress_class="" issuer="" storage_class=""
work="" package="" chart_dir="" context="" first_install=false
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

lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------------------------------------------------------------------------------------------------
# Values files: the chart's `secrets` block and the settings file written here share one layout.
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

# `<secret><TAB><key><TAB><value as written>` for each credential under `secrets` in a values file.
secret_entries() {
  awk '
    /^secrets:/ { inside = 1; next }
    inside && /^[^ #]/ { exit }
    inside && /^  [a-z0-9-]+:[ ]*$/ { secret = $1; sub(/:$/, "", secret); next }
    inside && /^    [a-z0-9-]+:/ {
      key = $1; sub(/:$/, "", key)
      value = $0; sub(/^    [a-z0-9-]+:[ ]*/, "", value)
      printf "%s\t%s\t%s\n", secret, key, value
    }
  ' "$1"
}

# The `secrets` block from `<secret><TAB><key><TAB><value>` lines, grouped by Secret in first-seen order.
render_secrets() {
  awk -F '\t' '
    !($1 in lines) { order[++count] = $1 }
    { lines[$1] = lines[$1] "    " $2 ": " $3 "\n" }
    END { print "secrets:"; for (i = 1; i <= count; i++) printf "  %s:\n%s", order[i], lines[order[i]] }
  ' "$1"
}

# A values file without its `secrets` block.
without_secrets() { awk '/^secrets:/ { skip = 1; next } skip && /^[^ #]/ { skip = 0 } !skip' "$1"; }

# A `global` setting from the settings file, unquoted.
saved_setting() {
  sed -n "s/^  $1: *//p" "$settings_file" | head -n 1 | sed "s/^'\(.*\)'\$/\1/"
}

# ---------------------------------------------------------------------------------------------------
# Questions.
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

# One Ingress's settings under `global`: its class, certificate issuer, TLS Secret, and an extra
# annotation. Nothing is written when there is nothing to set: a key with nothing under it is null,
# which would clear the chart's own settings for that Ingress.
ingress_settings() {
  local name=$1 tls_secret=$2 extra_annotation=${3:-} annotations="" lines=""
  if [ -n "$issuer" ]; then
    annotations="      cert-manager.io/cluster-issuer: $(yaml_quote "$issuer")"$'\n'
  fi
  if [ -n "$extra_annotation" ]; then annotations+="      $extra_annotation"$'\n'; fi
  if [ -n "$ingress_class" ]; then lines+="    className: $(yaml_quote "$ingress_class")"$'\n'; fi
  if [ -n "$annotations" ]; then lines+="    annotations:"$'\n'"$annotations"; fi
  if [ -n "$issuer" ]; then lines+="    tlsSecretName: $(yaml_quote "$tls_secret")"$'\n'; fi
  if [ -n "$lines" ]; then printf '  %s:\n%s' "$name" "$lines"; fi
}

# Ask for the installation's settings and write the settings file's header and `global` block.
ask_settings() {
  local domain body_size=""
  say ""
  say "Cluster settings"
  ask_namespace
  ask_hostname app_host "Hostname the application is served on, such as everything.example.com"
  # Siblings of the application's hostname share its domain, as the app host's login cookie needs.
  case $app_host in
    *.*.*) domain=${app_host#*.} ;;
    *) domain=$app_host ;;
  esac
  while true; do
    ask_hostname artifact_host "Hostname for apps, another name on the same domain" "artifacts.$domain"
    if [ "$artifact_host" != "$app_host" ]; then break; fi
    say "Apps need a hostname of their own."
  done
  while true; do
    ask_hostname registry_host "Hostname of the image registry nodes pull from" "images.$domain"
    if [ "$registry_host" != "$app_host" ] && [ "$registry_host" != "$artifact_host" ]; then break; fi
    say "The registry needs a hostname of its own."
  done
  ask ingress_class "Name of the ingress class to use (Enter for the cluster's default)"
  ask issuer "Name of the cert-manager ClusterIssuer to use for TLS (Enter if your ingress handles TLS)"
  ask storage_class "Name of the storage class to use (Enter for the cluster's default)"
  # ingress-nginx limits request bodies, and the registry receives whole image layers.
  case $ingress_class in
    *nginx*) body_size="nginx.ingress.kubernetes.io/proxy-body-size: '0'" ;;
  esac

  {
    echo "# Everything's installation settings and credentials, written by install.sh. Keep this file"
    echo "# private. Later runs of the installer reuse it; changing a database password here after the"
    echo "# first installation does not change it inside PostgreSQL."
    echo "# namespace: $namespace"
    echo "global:"
    echo "  externalHostname: $(yaml_quote "$app_host")"
    echo "  externalArtifactHostname: $(yaml_quote "$artifact_host")"
    echo "  externalRegistryHostname: $(yaml_quote "$registry_host")"
    if [ -n "$storage_class" ]; then echo "  storageClassName: $(yaml_quote "$storage_class")"; fi
    ingress_settings ingress everything-tls
    ingress_settings artifactIngress everything-artifacts-tls
    ingress_settings registryIngress everything-registry-tls "$body_size"
  } > "$work/settings.yaml"
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

# Ask for every credential the chart declares that the settings file lacks: all of them for new
# settings, and those a newer chart added for saved ones.
collect_credentials() {
  local missing secret key value
  : > "$work/secrets.tsv"
  if [ "$reuse" = true ]; then secret_entries "$settings_file" > "$work/secrets.tsv"; fi
  # The chart's credentials, in its order, less those already saved; FILENAME, unlike NR == FNR,
  # also tells the files apart when nothing is saved.
  missing=$(awk -F '\t' '
    FILENAME == ARGV[1] { saved[$1 "\t" $2] = 1; next }
    !(($1 "\t" $2) in saved) { print $1 "\t" $2 }
  ' "$work/secrets.tsv" <(secret_entries "$chart_dir/values.yaml"))
  if [ -z "$missing" ]; then return; fi
  say ""
  if [ "$reuse" = true ]; then
    say "Version $version needs credentials your settings file lacks."
  else
    say "Credentials"
  fi
  say "Press Enter to generate a random value; every value is saved in the settings file."
  while IFS=$'\t' read -r secret key; do
    # A plain assignment, so a failed prompt stops the installer instead of saving an empty value.
    value=$(credential "$secret" "$key")
    printf '%s\t%s\t%s\n' "$secret" "$key" "$(yaml_quote "$value")" >> "$work/secrets.tsv"
  done <<< "$missing"
  credentials_changed=true
}

save_settings() {
  if [ "$reuse" = true ] && [ "$credentials_changed" = false ]; then return; fi
  if [ "$reuse" = true ]; then without_secrets "$settings_file" > "$work/settings.yaml"; fi
  render_secrets "$work/secrets.tsv" >> "$work/settings.yaml"
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

# Download the chart once: its values declare the credentials, and its production values sit under
# the settings file.
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
  local action
  context=$(kubectl config current-context 2> /dev/null) ||
    fail "kubectl has no current context; select the target cluster first."
  # An existing release means this run upgrades it.
  if helm status "$release" --kube-context "$context" --namespace "$namespace" > /dev/null 2>&1; then
    first_install=false
    action="Upgrade Everything in namespace $namespace to $version"
  else
    first_install=true
    action="Install Everything $version into namespace $namespace"
  fi
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
  helm upgrade "$release" "$package" --install --kube-context "$context" --namespace "$namespace" \
    --values "$chart_dir/values.prod.yaml" --values "$settings_file"
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
  app_host=$(saved_setting externalHostname)
  say ""
  if [ "$first_install" = true ]; then
    say "Everything $version is installed in namespace $namespace."
    say "  Point DNS for $app_host, $(saved_setting externalArtifactHostname), and"
    say "  $(saved_setting externalRegistryHostname) at your ingress controller."
  else
    say "Everything is upgraded to $version in namespace $namespace."
  fi
  say "  Watch its pods: kubectl -n $namespace get pods -w"
  if [ -n "$first_user" ]; then
    say "  Sign in at https://$app_host as $first_user."
  else
    say "  Sign in at https://$app_host."
  fi
  say "  To upgrade, run the installer again and reuse $settings_file."
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
  if [ "$reuse" = true ]; then
    namespace=$(sed -n 's/^# namespace: *//p' "$settings_file" | head -n 1)
    if [ -z "$namespace" ]; then ask_namespace; fi
  else
    ask_settings
  fi
  collect_credentials
  save_settings
  install_release
  setup_first_user
  print_next_steps
}

# Everything runs from here, so a partial download runs nothing.
main "$@"
