import assert from "node:assert/strict";
import { test } from "node:test";
import { UnsecuredJWT } from "jose";
import {
  KeycloakPasswordAuthentication,
  AuthenticationFailure,
} from "../adapter/keycloak-password-authentication.js";
import { SessionCipher } from "../service/session-cipher.js";
import { createBrowserSession } from "../factory/browser-session.js";

const config = {
  protocolUrl: "http://identity.test/protocol",
  clientId: "web",
  clientSecret: "private-client-secret",
  publicOrigin: "https://app.test",
};

test("server provider sends a confidential back-channel grant and verifies tokens before reading claims", async () => {
  const token = new UnsecuredJWT({
    sub: "owner",
    preferred_username: "Owner",
    exp: Math.floor(Date.now() / 1000) + 60,
  }).encode();
  const requests: { url: string; options: RequestInit }[] = [];
  const verified: string[] = [];
  const provider = new KeycloakPasswordAuthentication(
    config,
    {
      /** Record verification before the adapter trusts any token claims. */
      async verify(value) {
        verified.push(value);
        return { subject: "owner" };
      },
    },
    async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return Response.json({
        access_token: token,
        refresh_token: "rotated-refresh",
        expires_in: 60,
        refresh_expires_in: 1800,
      });
    },
  );
  const grant = await provider.authenticate({
    username: "owner",
    password: "secret-password",
  });
  await provider.refresh(grant.refreshToken);
  await provider.revoke(grant.refreshToken);
  assert.deepEqual(grant.profile, { subject: "owner", displayName: "Owner" });
  assert.deepEqual(verified, [token, token]);
  const body = new URLSearchParams(String(requests[0]!.options.body));
  assert.equal(body.get("client_secret"), config.clientSecret);
  assert.equal(body.get("password"), "secret-password");
  assert.equal(body.get("grant_type"), "password");
  assert.equal(requests[0]!.options.redirect, "error");
  assert.ok(requests[0]!.options.signal);
  assert.equal(
    new Headers(requests[0]!.options.headers).get("x-forwarded-proto"),
    "https",
  );
  assert.equal(
    new URLSearchParams(String(requests[1]!.options.body)).has("password"),
    false,
  );
  assert.equal(requests[2]!.url, config.protocolUrl + "/logout");
});

test("provider failures and invalid token verification reveal no credentials or upstream details", async () => {
  for (const [status, error, reason] of [
    [400, "invalid_grant", "rejected"],
    [401, "invalid_client", "unavailable"],
    [503, "private upstream details", "unavailable"],
  ] as const) {
    const provider = new KeycloakPasswordAuthentication(
      config,
      {
        /** Failed responses must never reach token verification. */
        async verify() {
          throw new Error("Must not verify");
        },
      },
      async () => Response.json({ error }, { status }),
    );
    await assert.rejects(
      provider.authenticate({ username: "x", password: "private" }),
      (failure) =>
        failure instanceof AuthenticationFailure &&
        failure.reason === reason &&
        !failure.message.includes("private"),
    );
  }
});

test("credential encryption rejects tampering and the wrong key", async () => {
  const cipher = new SessionCipher(Buffer.alloc(32, 1).toString("base64"));
  const ciphertext = await cipher.seal("refresh-secret");
  assert.ok(!ciphertext.includes("refresh-secret"));
  assert.equal(await cipher.open(ciphertext), "refresh-secret");
  await assert.rejects(cipher.open(ciphertext.slice(0, -10) + "AAAAAAAAAA"));
  await assert.rejects(
    new SessionCipher(Buffer.alloc(32, 2).toString("base64")).open(ciphertext),
  );
  assert.throws(() => new SessionCipher("short"));
});

test("browser adapter uses fixed same-origin endpoints and returns profiles without retaining credentials", async () => {
  const calls: { path: string; options: RequestInit }[] = [];
  const profile = { subject: "owner", displayName: "Owner" };
  const session = createBrowserSession(async (path, options = {}) => {
    calls.push({ path: String(path), options });
    return String(path).endsWith("/logout")
      ? new Response(null, { status: 204 })
      : Response.json({ profile: options.method === "POST" ? profile : null });
  });
  assert.equal(await session.initialize(), null);
  assert.equal(await session.initialize(), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    await session.signIn({ username: "owner", password: "password" }),
    profile,
  );
  await session.signOut();
  assert.equal(await session.initialize(), null);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/v1/session", "/v1/session", "/v1/session/logout"],
  );
  assert.ok(
    calls.every(
      (call) =>
        call.options.credentials === "same-origin" &&
        call.options.redirect === "error" &&
        call.options.cache === "no-store",
    ),
  );
});
