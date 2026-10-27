import assert from "node:assert/strict";
import { test } from "node:test";
import { loadApplicationConfig } from "../config/application-config.js";

/** A minimal non-secret deployment fixture independent of process.env. */
function environment(): NodeJS.ProcessEnv {
  return {
    PUBLIC_ORIGIN: "https://everything.test",
    ARTIFACT_ORIGIN: "https://artifacts.everything.test",
    PUBLIC_APPS_ORIGIN: "https://public-apps.everything.test",
    OIDC_ISSUER: "https://everything.test/auth/realms/everything",
    OIDC_JWKS_URL: "http://keycloak:8080/certs",
    OIDC_AUDIENCE: "everything-artifact",
    EVERYTHING_API_URL: "http://everything.everything.svc.cluster.local:8080",
    EVERYTHING_API_AUDIENCE: "everything-api",
    KEYCLOAK_ADMIN_URL: "http://keycloak:8080/auth/admin/realms/everything",
    KEYCLOAK_PROTOCOL_URL:
      "http://keycloak:8080/auth/realms/everything/protocol/openid-connect",
    APP_PROVISIONER_CLIENT_ID: "everything-app-provisioner",
    APP_PROVISIONER_CLIENT_SECRET: "test-only",
    DATABASE_URL: "postgresql://artifact@postgres:5432/artifact",
    DATABASE_PASSWORD: "test-only",
    ARTIFACT_DATA_DATABASE: "artifact_data",
    ARTIFACT_DATABASE_HOST: "postgres.everything.svc.cluster.local:5433",
    CONTENT_DIRECTORY: "/content",
    ARTIFACT_NAMESPACE: "everything-artifacts",
    BUILD_NAMESPACE: "everything-builds",
    REGISTRY_URL: "http://registry:5000",
    REGISTRY_USERNAME: "everything",
    REGISTRY_PASSWORD: "test-only",
    REGISTRY_PUSH_HOST: "registry.everything.svc.cluster.local:5000",
    REGISTRY_PULL_HOST: "localhost:30500",
    REGISTRY_PULL_SECRET: "registry-pull",
    REGISTRY_PUSH_SECRET: "registry-push",
    BUILD_SOURCE_URL: "http://artifact.everything.svc.cluster.local:8081",
    BUILDKIT_IMAGE: "moby/buildkit:v0.33.1-rootless",
  };
}

test("defaults the two ports and splits the artifact database address", () => {
  const config = loadApplicationConfig(environment());
  assert.deepEqual(
    [config.port, config.internalPort, config.publicAppsPort],
    [8080, 8081, 8082],
  );
  assert.equal(config.publicAppsOrigin, "https://public-apps.everything.test");
  assert.deepEqual(config.artifactData, {
    database: "artifact_data",
    host: "postgres.everything.svc.cluster.local",
    port: 5433,
  });
  assert.equal(config.cluster.storageClassName, "");
});

test("rejects invalid deployment input", () => {
  for (const override of [
    { ARTIFACT_ORIGIN: "https://artifacts.test/path" },
    { CONTENT_DIRECTORY: "relative" },
    { ARTIFACT_NAMESPACE: "Not_A_Namespace" },
    { REGISTRY_PULL_HOST: "localhost:30500/path" },
    { REGISTRY_PASSWORD: undefined },
    { INTERNAL_PORT: "70000" },
  ])
    assert.throws(() =>
      loadApplicationConfig({ ...environment(), ...override }),
    );
});

test("public apps need a cookie host apart from the artifact host's and the application's", () => {
  // Browsers scope cookies by hostname, not port or scheme: each of these would hand private apps'
  // own cookies, or Everything's, to every public app.
  for (const override of [
    { PUBLIC_APPS_ORIGIN: "https://artifacts.everything.test" },
    { PUBLIC_APPS_ORIGIN: "https://everything.test" },
    { PUBLIC_APPS_ORIGIN: "https://ARTIFACTS.everything.test:443" },
    { PUBLIC_APPS_ORIGIN: "http://artifacts.everything.test:8082" },
    { PUBLIC_APPS_ORIGIN: "https://Artifacts.Everything.Test.:8443" },
    { PUBLIC_APPS_ORIGIN: "http://everything.test.:9000" },
    // The ports the development stack forwards, all on localhost.
    {
      PUBLIC_ORIGIN: "http://localhost:8080",
      ARTIFACT_ORIGIN: "http://localhost:8081",
      PUBLIC_APPS_ORIGIN: "http://localhost:8082",
    },
    {
      PUBLIC_ORIGIN: "http://localhost:8080",
      ARTIFACT_ORIGIN: "http://127.0.0.1:8081",
      PUBLIC_APPS_ORIGIN: "http://LOCALHOST.:8082",
    },
  ])
    assert.throws(
      () => loadApplicationConfig({ ...environment(), ...override }),
      /PUBLIC_APPS_ORIGIN needs a hostname apart/,
      JSON.stringify(override),
    );
  for (const override of [
    {},
    // The development stack: another loopback hostname beside localhost.
    {
      PUBLIC_ORIGIN: "http://localhost:8080",
      ARTIFACT_ORIGIN: "http://localhost:8081",
      PUBLIC_APPS_ORIGIN: "http://127.0.0.1:8082",
    },
    { PUBLIC_APPS_ORIGIN: "https://apps.everything.test" },
  ])
    assert.equal(
      loadApplicationConfig({ ...environment(), ...override }).publicAppsOrigin,
      override.PUBLIC_APPS_ORIGIN ?? "https://public-apps.everything.test",
    );
});
