import assert from "node:assert/strict";
import { test } from "node:test";
import { loadApplicationConfig } from "../config/application-config.js";
/** Provide a minimal non-secret deployment fixture independent of process.env. */
function environment(): NodeJS.ProcessEnv {
  return {
    OIDC_ISSUER: "https://identity.test",
    OIDC_JWKS_URL: "https://identity.test/keys",
    OIDC_AUDIENCE: "api",
    PUBLIC_ORIGIN: "https://app.test",
    OIDC_PROTOCOL_URL: "http://identity.test/protocol/openid-connect",
    OIDC_CLIENT_ID: "web",
    OIDC_CLIENT_SECRET: "test-only",
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    DATABASE_URL: "postgresql://app@db/app",
    DATABASE_PASSWORD: "test-only",
    PI_STATE_DIRECTORY: "/state",
    AGENTS_DIRECTORY: "/agents",
  };
}
test("env-schema applies port defaults/coercion without changing the supplied environment", () => {
  const source = environment();
  assert.equal(loadApplicationConfig(source).port, 8080);
  assert.equal(loadApplicationConfig({ ...source, PORT: "9443" }).port, 9443);
  assert.equal(source.PORT, undefined);
});
test("rejects invalid deployment input", () => {
  for (const override of [
    { PORT: "65536" },
    { PORT: "3.5" },
    { DATABASE_PASSWORD: "" },
    { DATABASE_PASSWORD: undefined },
    { DATABASE_URL: "https://db/app" },
    { AGENTS_DIRECTORY: undefined },
    { AGENTS_DIRECTORY: "relative/agents" },
  ])
    assert.throws(() =>
      loadApplicationConfig({ ...environment(), ...override }),
    );
});
