#!/usr/bin/env bash
# Upgrade an existing realm with the app provisioner's service client without replacing the realm.
set -euo pipefail
umask 077

# ===========================================
# Administration
# ===========================================

configuration=$(mktemp)
trap 'rm -f "$configuration"' EXIT

# Run the admin CLI with a temporary credential cache, removed when this migration exits.
admin() {
  /opt/keycloak/bin/kcadm.sh "$@" --config "$configuration"
}

admin config credentials --server http://localhost:8080/auth --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null

# ===========================================
# Provisioning identity
# ===========================================

client_id=everything-app-provisioner
client_uuid=$(admin get clients -r "$EVERYTHING_REALM" -q "clientId=$client_id" --fields id \
  | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -z "$client_uuid" ]; then
  client_uuid=$(admin create clients -r "$EVERYTHING_REALM" -i \
    -s "clientId=$client_id" -s protocol=openid-connect \
    -s publicClient=false -s serviceAccountsEnabled=true \
    -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false)
fi
admin update "clients/$client_uuid" -r "$EVERYTHING_REALM" \
  -s enabled=true -s publicClient=false -s clientAuthenticatorType=client-secret \
  -s "secret=$EVERYTHING_APP_PROVISIONER_CLIENT_SECRET" \
  -s serviceAccountsEnabled=true -s standardFlowEnabled=false \
  -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false
admin add-roles -r "$EVERYTHING_REALM" --uusername "service-account-$client_id" \
  --cclientid realm-management --rolename manage-clients
# TLS ends at ingress. Private pod addresses can use the internal HTTP token endpoint.
admin update "realms/$EVERYTHING_REALM" -s sslRequired=external
echo "App API client provisioning is ready."
