import assert from "node:assert/strict";
import { test } from "node:test";
import { KeycloakClientCredentials } from "../adapter/keycloak-client-credentials.js";

const config = {
  protocolUrl: "http://identity.test/protocol",
  publicOrigin: "https://app.test",
  clientId: "service",
  clientSecret: "service-secret",
};

/** A token source over a fake provider issuing numbered tokens that expire after `expiresIn` seconds. */
function fixture(expiresIn = 300) {
  const requests: { url: string; options: RequestInit }[] = [];
  let clock = 1_000_000;
  const source = new KeycloakClientCredentials(
    config,
    async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return Response.json({
        access_token: `token-${requests.length}`,
        expires_in: expiresIn,
      });
    },
    () => clock,
  );
  return {
    source,
    requests,
    /** Move the fake clock forward. */
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("requests a client credentials grant through the public origin", async () => {
  const { source, requests } = fixture();
  assert.equal(await source.token(), "token-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://identity.test/protocol/token");
  const body = new URLSearchParams(String(requests[0]?.options.body));
  assert.equal(body.get("grant_type"), "client_credentials");
  assert.equal(body.get("client_id"), "service");
  assert.equal(body.get("client_secret"), "service-secret");
  const headers = requests[0]?.options.headers as Record<string, string>;
  assert.equal(headers["X-Forwarded-Host"], "app.test");
  assert.equal(headers["X-Forwarded-Proto"], "https");
});

test("reuses a token until shortly before it expires", async () => {
  const { source, requests, advance } = fixture(300);
  await source.token();
  advance(260_000);
  assert.equal(await source.token(), "token-1");
  advance(20_000);
  assert.equal(await source.token(), "token-2");
  assert.equal(requests.length, 2);
});

test("shares one request among concurrent callers", async () => {
  const { source, requests } = fixture();
  const tokens = await Promise.all([source.token(), source.token()]);
  assert.deepEqual(tokens, ["token-1", "token-1"]);
  assert.equal(requests.length, 1);
});

test("rejects refused and malformed responses, then retries on the next call", async () => {
  let attempt = 0;
  const source = new KeycloakClientCredentials(config, async () => {
    attempt += 1;
    if (attempt === 1) return new Response("{}", { status: 401 });
    if (attempt === 2) return Response.json({ access_token: 7 });
    return Response.json({ access_token: "valid", expires_in: 60 });
  });
  await assert.rejects(
    source.token(),
    /refused the client credentials \(401\)/,
  );
  await assert.rejects(source.token(), /invalid token/);
  assert.equal(await source.token(), "valid");
});
