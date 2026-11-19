# Keycloak 26.8.2-3, pinned by digest. It bundles Red Hat OpenJDK 21.0.13.1, which fixes CVE-2026-114938.
# Both stages start from this one base, so the build and the runtime always use the same Keycloak and Java.
FROM quay.io/keycloak/keycloak:26.8.2-3@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3 AS keycloak

FROM keycloak AS build
# Build-time options: Keycloak is served under /auth on the application's origin; health stays at /health.
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_HTTP_RELATIVE_PATH=/auth KC_HTTP_MANAGEMENT_RELATIVE_PATH=/
RUN /opt/keycloak/bin/kc.sh build

FROM keycloak
COPY --from=build /opt/keycloak/ /opt/keycloak/
COPY --chmod=755 services/keycloak/src/realm/script/provision-app-client.sh /opt/keycloak/bin/provision-app-client.sh
USER 1000:1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
