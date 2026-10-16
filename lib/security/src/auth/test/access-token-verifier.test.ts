import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AccessTokenVerifier } from "../service/access-token-verifier.js";

const issuer = "https://identity.example.test/realms/everything";
const audience = "everything-api";
const keys = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const verifier = new AccessTokenVerifier(
  createLocalJWKSet({ keys: [jwk] }),
  issuer,
  audience,
);

/** Sign test claims with a trusted key unless an explicit forgery is requested. */
async function token(
  overrides: Record<string, unknown> = {},
  forged = false,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: "owner-id",
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + 300,
    typ: "Bearer",
    ...overrides,
  };
  const signingKey = forged
    ? (await generateKeyPair("RS256")).privateKey
    : keys.privateKey;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(signingKey);
}

test("accepts a signed Keycloak access token", async () => {
  assert.deepEqual(await verifier.verify(await token()), {
    subject: "owner-id",
  });
});

test("service identity policy runs only after signature, issuer, audience, and expiry verification", async () => {
  const seen: unknown[] = [];
  const delegated = new AccessTokenVerifier(
    createLocalJWKSet({ keys: [jwk] }),
    issuer,
    audience,
    (identity, claims) => {
      seen.push([identity.subject, claims.app_owner]);
      return { subject: String(claims.app_owner) };
    },
  );
  assert.deepEqual(
    await delegated.verify(await token({ app_owner: "owner" })),
    { subject: "owner" },
  );
  for (const claims of [
    { aud: "everything-artifact" },
    { iss: "https://other.test" },
    { exp: 1 },
  ])
    await assert.rejects(
      delegated.verify(await token({ app_owner: "owner", ...claims })),
    );
  await assert.rejects(
    delegated.verify(await token({ app_owner: "owner" }, true)),
  );
  assert.deepEqual(seen, [["owner-id", "owner"]]);
});
for (const [name, claims] of Object.entries({
  expired: { exp: Math.floor(Date.now() / 1000) - 60 },
  issuer: { iss: "https://attacker.example.test" },
  audience: { aud: "other-api" },
  subject: { sub: "" },
  "ID token": { typ: "ID" },
  "missing expiration": { exp: undefined },
  "future validity": { nbf: Math.floor(Date.now() / 1000) + 120 },
})) {
  test(`rejects invalid ${name}`, async () => {
    await assert.rejects(verifier.verify(await token(claims)));
  });
}
test("rejects forged signatures even with the trusted key id", async () => {
  await assert.rejects(verifier.verify(await token({}, true)));
});
test("rejects unsigned and malformed tokens", async () => {
  await assert.rejects(
    verifier.verify("eyJhbGciOiJub25lIn0.eyJzdWIiOiJvd25lci1pZCJ9."),
  );
  await assert.rejects(verifier.verify("not-a-token"));
});
