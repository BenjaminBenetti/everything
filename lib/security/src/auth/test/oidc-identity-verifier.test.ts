import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createOidcIdentityVerifier } from "../factory/oidc-identity-verifier.js";

test("OIDC identity validation checks the signature, issued audience, nonce, issuer, and expiry", async (context) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
  };
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const verifier = createOidcIdentityVerifier(
    "https://issuer.test",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/keys`,
  );
  /** Sign a fixture identity using controlled claims. */
  async function token(
    issuer = "https://issuer.test",
    expiry = "2m",
  ): Promise<string> {
    return new SignJWT({ nonce: "nonce", email: "person@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("issued-client")
      .setSubject("person")
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);
  }
  const signed = await token();
  assert.deepEqual(await verifier.verify(signed, "issued-client", "nonce"), {
    subject: "person",
    email: "person@example.test",
  });
  await assert.rejects(verifier.verify(signed, "other-client", "nonce"));
  await assert.rejects(verifier.verify(signed, "issued-client", "wrong-nonce"));
  await assert.rejects(
    verifier.verify(
      await token("https://wrong.test"),
      "issued-client",
      "nonce",
    ),
  );
  await assert.rejects(
    verifier.verify(
      await token("https://issuer.test", "-1m"),
      "issued-client",
      "nonce",
    ),
  );
});
