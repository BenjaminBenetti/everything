#!/bin/sh
set -eu
# The artifact role owns the artifact service's database and the database holding each dynamic
# artifact's schema; CREATEROLE lets it create one login role per artifact.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=keycloak_password="$KEYCLOAK_DB_PASSWORD" --set=everything_password="$EVERYTHING_DB_PASSWORD" \
  --set=artifact_password="$ARTIFACT_DB_PASSWORD" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_password';
CREATE DATABASE keycloak OWNER keycloak;
CREATE ROLE everything LOGIN PASSWORD :'everything_password';
CREATE DATABASE everything OWNER everything;
CREATE ROLE artifact LOGIN CREATEROLE PASSWORD :'artifact_password';
CREATE DATABASE artifact OWNER artifact;
CREATE DATABASE artifact_data OWNER artifact;
REVOKE CONNECT ON DATABASE keycloak FROM PUBLIC;
REVOKE CONNECT ON DATABASE everything FROM PUBLIC;
REVOKE CONNECT ON DATABASE artifact FROM PUBLIC;
REVOKE CONNECT ON DATABASE artifact_data FROM PUBLIC;
SQL
