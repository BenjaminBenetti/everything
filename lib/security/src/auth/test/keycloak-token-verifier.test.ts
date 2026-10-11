import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeycloakTokenVerifier } from "../factory/keycloak-token-verifier.js";

const configuration = {
  issuer: "https://identity.example.test/auth/realms/everything",
  jwksUrl:
    "http://keycloak:8080/auth/realms/everything/protocol/openid-connect/certs",
  audience: "everything-api",
};

test("accepts HTTP and HTTPS endpoints, leaving transport security to the cluster", () => {
  assert.doesNotThrow(() => createKeycloakTokenVerifier(configuration));
});

test("rejects non-HTTP endpoints and a missing audience", () => {
  for (const override of [
    { issuer: "not a url" },
    { jwksUrl: "file:///etc/keys.json" },
    { audience: " " },
  ]) {
    assert.throws(() =>
      createKeycloakTokenVerifier({ ...configuration, ...override }),
    );
  }
});
