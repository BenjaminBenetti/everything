#!/usr/bin/env bash
# Give the app provisioner's service client what the artifact service needs in an existing realm,
# without replacing the realm.
#
#   provision-app-client.sh
#     Create or repair the client: its secret, its realm-management manage-clients role, Keycloak's
#     built-in kc-admin-api client scope among its default scopes, and the realm's TLS setting.
#     cluster:up runs this in the Keycloak pod.
#   provision-app-client.sh --admin-api-scope [--post-start]
#     Only add kc-admin-api to the existing client's default scopes when it is missing, and confirm it
#     is there. Nothing else is created, replaced, or removed. With --post-start, run as the Keycloak
#     container's postStart hook; see "Startup hook" below.
#
# Since Keycloak 26.8.2, the Admin REST API accepts only tokens that carry the kc-admin-api scope and
# the realm's Admin API audience, which that scope adds. The scope changes the token's audience, not
# what the client may do: its manage-clients role still decides that.
set +x
set -euo pipefail
umask 077

# ===========================================
# Settings
# ===========================================

client_id=everything-app-provisioner
scope_name=kc-admin-api
realm=${EVERYTHING_REALM:-}
# This server, over loopback: Keycloak serves under /auth, and its health checks on the management port.
server="http://localhost:${KC_HTTP_PORT:-8080}/auth"
management_port=${KC_HTTP_MANAGEMENT_PORT:-9000}
# The admin CLI, and the Keycloak process's log; replaceable only so the tests can stand in for them.
kcadm=${KEYCLOAK_ADMIN_CLI:-/opt/keycloak/bin/kcadm.sh}
process_log=${KEYCLOAK_PROCESS_LOG:-/proc/1/fd/2}
# How long the scope migration waits for this server to become ready: what the chart's startup probe
# allows (60 checks, 5 seconds apart), since the kubelet runs no probes until the hook has finished.
ready_seconds=${ADMIN_API_SCOPE_READY_SECONDS:-300}
# Any one admin CLI call stops after this long.
call_seconds=60

usage() {
  echo "Usage: provision-app-client.sh [--admin-api-scope [--post-start]]" >&2
  exit 2
}
scope_only=false
post_start=false
for argument in "$@"; do
  case $argument in
    --admin-api-scope) scope_only=true ;;
    --post-start) post_start=true ;;
    *) usage ;;
  esac
done
if [ "$post_start" = true ] && [ "$scope_only" = false ]; then usage; fi
[[ $ready_seconds =~ ^[0-9]+$ ]] || usage

# ===========================================
# Reporting
# ===========================================

# Kubernetes keeps a postStart hook's output only when the hook fails, so the hook also copies its
# messages, and the admin CLI's, to the Keycloak process's own log; never to its own output, as when
# it is the container's first process itself.
log_copy=""
if [ "$post_start" = true ] && [ "$$" != 1 ] && ! [ "$process_log" -ef /dev/stderr ] &&
  { : >> "$process_log"; } 2> /dev/null; then
  exec 2> >(tee -a "$process_log" >&2)
  log_copy=$!
fi

say() {
  printf 'provision-app-client: %s\n' "$*" >&2
}

# ===========================================
# Administration
# ===========================================

configuration=$(mktemp)
# The credential cache is private (umask 077) and removed however this script stops, short of SIGKILL.
finish() {
  rm -f "$configuration"
  if [ -n "$log_copy" ]; then
    exec 2>&-
    wait "$log_copy" 2> /dev/null || true
  fi
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Run the admin CLI with the temporary credential cache, bounded in time. It stays in this script's
# process group, so a signal that stops the script stops it too.
admin() {
  timeout --foreground "$call_seconds" "$kcadm" "$@" --config "$configuration"
}

# Whether a list of IDs, one per line, contains an ID.
listed() {
  [[ $'\n'$1$'\n' == *$'\n'"$2"$'\n'* ]]
}

# Whether this server reports itself ready on its management port, asked over loopback.
ready() {
  local status
  # shellcheck disable=SC2016 # The inner shell expands $1.
  status=$(timeout 5 bash -c 'exec 3<> "/dev/tcp/127.0.0.1/$1" &&
    printf "GET /health/ready HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3 &&
    IFS= read -r line <&3 && printf "%s" "$line"' ready "$management_port" 2> /dev/null) || return 1
  [[ $status == "HTTP/1."?" 200"* ]]
}

# Wait, bounded, until this server is ready.
wait_until_ready() {
  local deadline=$((SECONDS + ready_seconds))
  until ready; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "Keycloak was not ready within ${ready_seconds}s on 127.0.0.1:$management_port."
      return 1
    fi
    sleep 2
  done
}

# Sign in to the master realm as the bootstrap administrator from this container's environment.
sign_in() {
  local output
  if output=$(admin config credentials --server "$server" --realm master \
    --user "${KC_BOOTSTRAP_ADMIN_USERNAME:-}" --password "${KC_BOOTSTRAP_ADMIN_PASSWORD:-}" 2>&1 > /dev/null); then
    return 0
  fi
  say "Keycloak refused the bootstrap administrator from KC_BOOTSTRAP_ADMIN_USERNAME and" \
    "KC_BOOTSTRAP_ADMIN_PASSWORD (${output##*$'\n'}). Nothing was changed."
  return 1
}

# ===========================================
# Admin REST API scope
# ===========================================

# The ID of the realm's one OpenID Connect client scope named kc-admin-api, which Keycloak creates in
# every realm. Found by its exact name; never guessed or created here.
admin_api_scope() {
  local rows matches
  rows=$(admin get client-scopes -r "$realm" --fields id,name,protocol --format csv) || {
    say "Could not list the client scopes of realm $realm. Nothing was changed."
    return 1
  }
  matches=$(printf '%s\n' "$rows" | sed -n "s/^\"\([A-Za-z0-9-]*\)\",\"$scope_name\",\"openid-connect\"$/\1/p")
  if [ -z "$matches" ] || [[ $matches == *$'\n'* ]]; then
    say "Realm $realm has no single OpenID Connect client scope named $scope_name, which Keycloak" \
      "26.8.2 creates in every realm. Nothing was changed."
    return 1
  fi
  printf '%s\n' "$matches"
}

# The IDs of a client's `default` or `optional` client scopes, one per line.
client_scopes() {
  admin get "clients/$1/$2-client-scopes" -r "$realm" --fields id --format csv --noquotes
}

# Make kc-admin-api one of the client's default scopes, unless it already is, and confirm it is.
# Its other scopes, its optional ones included, are left exactly as they are.
ensure_admin_api_scope() {
  local client=$1 scope defaults optional
  scope=$(admin_api_scope) || return 1
  defaults=$(client_scopes "$client" default) || {
    say "Could not list the default client scopes of $client_id. Nothing was changed."
    return 1
  }
  if listed "$defaults" "$scope"; then
    say "$client_id already has the $scope_name default client scope in realm $realm."
    return 0
  fi
  optional=$(client_scopes "$client" optional) || {
    say "Could not list the optional client scopes of $client_id. Nothing was changed."
    return 1
  }
  if listed "$optional" "$scope"; then
    say "$client_id has $scope_name as an optional client scope, which the artifact service never" \
      "requests. Make it a default client scope instead. Nothing was changed."
    return 1
  fi
  # Another run may add it first; the check below decides either way.
  admin update "clients/$client/default-client-scopes/$scope" -r "$realm" || true
  defaults=$(client_scopes "$client" default) || defaults=""
  if ! listed "$defaults" "$scope"; then
    say "Keycloak did not add the $scope_name default client scope to $client_id in realm $realm."
    return 1
  fi
  say "Added the $scope_name default client scope to $client_id in realm $realm."
}

# The existing client's ID, when it is the confidential OpenID Connect client with a service account
# that the realm import or the full provisioning creates. Never created here.
provisioner_client() {
  local rows matches
  rows=$(admin get clients -r "$realm" -q "clientId=$client_id" \
    --fields id,clientId,protocol,publicClient,bearerOnly,serviceAccountsEnabled --format csv) || {
    say "Could not look up $client_id in realm $realm. Nothing was changed."
    return 1
  }
  matches=$(printf '%s\n' "$rows" | sed -n "s/^\"\([A-Za-z0-9-]*\)\",\"$client_id\",/\1,/p")
  if [ -z "$matches" ] || [[ $matches == *$'\n'* ]]; then
    say "Realm $realm has no single client $client_id. Nothing was changed."
    return 1
  fi
  if [ "${matches#*,}" != '"openid-connect",false,false,true' ]; then
    say "$client_id in realm $realm is not a confidential OpenID Connect client with a service" \
      "account. Nothing was changed."
    return 1
  fi
  printf '%s\n' "${matches%%,*}"
}

# Only the scope, in an existing realm and client.
migrate_admin_api_scope() {
  local client
  if [ -z "$realm" ]; then
    say "EVERYTHING_REALM names no realm. Nothing was changed."
    return 1
  fi
  sign_in || return 1
  client=$(provisioner_client) || return 1
  ensure_admin_api_scope "$client"
}

# ===========================================
# Startup hook
# ===========================================

# As the postStart hook, wait for this server, then add the scope. Only a server that never becomes
# ready, which the startup probe would restart anyway, fails the hook. A configuration problem, such
# as a bootstrap administrator that was removed or whose password changed, is reported in Keycloak's
# log and leaves Keycloak running: failing the hook would restart the container, and every sign-in
# with it, again and again without fixing anything.
if [ "$scope_only" = true ]; then
  wait_until_ready || exit 1
  if migrate_admin_api_scope; then exit 0; fi
  if [ "$post_start" = false ]; then exit 1; fi
  say "Could not confirm that $client_id has the $scope_name default client scope, without which the" \
    "artifact service cannot manage app clients. Keycloak keeps running; fix the cause above, then" \
    "restart Keycloak."
  exit 0
fi

# ===========================================
# Provisioning identity
# ===========================================

: "${realm:?EVERYTHING_REALM must name the realm}"
admin config credentials --server "$server" --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" > /dev/null

client_uuid=$(admin get clients -r "$realm" -q "clientId=$client_id" --fields id \
  | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -z "$client_uuid" ]; then
  client_uuid=$(admin create clients -r "$realm" -i \
    -s "clientId=$client_id" -s protocol=openid-connect \
    -s publicClient=false -s serviceAccountsEnabled=true \
    -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false)
fi
admin update "clients/$client_uuid" -r "$realm" \
  -s enabled=true -s publicClient=false -s clientAuthenticatorType=client-secret \
  -s "secret=$EVERYTHING_APP_PROVISIONER_CLIENT_SECRET" \
  -s serviceAccountsEnabled=true -s standardFlowEnabled=false \
  -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false
admin add-roles -r "$realm" --uusername "service-account-$client_id" \
  --cclientid realm-management --rolename manage-clients
ensure_admin_api_scope "$client_uuid"
# TLS ends at ingress. Private pod addresses can use the internal HTTP token endpoint.
admin update "realms/$realm" -s sslRequired=external
echo "App API client provisioning is ready."
