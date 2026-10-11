FROM quay.io/keycloak/keycloak:26.8.0 AS build
# Build-time options: Keycloak is served under /auth on the application's origin; health stays at /health.
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_HTTP_RELATIVE_PATH=/auth KC_HTTP_MANAGEMENT_RELATIVE_PATH=/
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.8.0
COPY --from=build /opt/keycloak/ /opt/keycloak/
USER 1000:1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
