import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { OpenAiChatGptAuthorization } from "../adapter/chatgpt-authorization.js";
import type { ProviderCredential } from "../model/stored-provider.js";

const redirectUri = "http://127.0.0.1:8080/v1/providers/chatgpt/callback";

/** Build a documented OAuth return address for an attempt. */
function callback(state: string, client = "issued-client"): string {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams({
    state,
    code: "test-code",
    client_id: client,
  }).toString();
  return url.href;
}

test("dynamic ChatGPT registration uses PKCE, a stable host, and the new token endpoint", async () => {
  let retained = false;
  let expectedNonce = "";
  const adapter = new OpenAiChatGptAuthorization(
    {
      /** Require the saved audience and nonce before accepting an identity. */
      async verify(_token, audience, nonce) {
        assert.equal(audience, "issued-client");
        assert.equal(nonce, expectedNonce);
        return { subject: "chatgpt-user", email: "account@example.test" };
      },
    },
    redirectUri,
    async (input, init) => {
      assert.equal(input, "https://auth.openai.com/api/accounts/oauth/token");
      assert.equal(retained, true);
      assert.equal(init?.redirect, "error");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("client_id"), "issued-client");
      assert.equal(body.get("redirect_uri"), redirectUri);
      assert.equal(body.get("resource"), "https://api.openai.com/v1");
      return new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          id_token: "identity",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid resource.invoke chatgpt.tokens.use.direct",
        }),
      );
    },
  );
  const attempt = adapter.begin({});
  const url = new URL(attempt.authorization.url);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "Everything");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(attempt.pending.verifier).digest("base64url"),
  );
  expectedNonce = attempt.pending.nonce;
  const result = await adapter.complete(
    attempt.credential,
    attempt.pending,
    callback(attempt.pending.state),
    async (credential) => {
      assert.equal(credential.clientId, "issued-client");
      retained = true;
    },
  );
  assert.equal(result.account, "account@example.test");
  const returning = adapter.begin(result.credential);
  assert.equal(returning.credential.hostId, attempt.credential.hostId);
  assert.equal(
    new URL(returning.authorization.url).searchParams.get("client_id"),
    "issued-client",
  );
  assert.equal(
    new URL(returning.authorization.url).searchParams.has("agent_name_hint"),
    false,
  );
  assert.notEqual(returning.pending.state, attempt.pending.state);
});

test("bad state, expiry, foreign callbacks, and returning client substitutions never reach token exchange", async () => {
  let calls = 0;
  const adapter = new OpenAiChatGptAuthorization(
    {
      async verify() {
        throw new Error("unexpected");
      },
    },
    redirectUri,
    async () => {
      calls++;
      throw new Error("unexpected");
    },
  );
  const attempt = adapter.begin({ clientId: "issued-client" });
  for (const [pending, address] of [
    [attempt.pending, callback("wrong")],
    [
      { ...attempt.pending, expiresAt: Date.now() - 1 },
      callback(attempt.pending.state),
    ],
    [attempt.pending, callback(attempt.pending.state, "another-client")],
    [
      attempt.pending,
      callback(attempt.pending.state).replace("127.0.0.1", "attacker.test"),
    ],
    [attempt.pending, callback(attempt.pending.state) + "&state=duplicate"],
  ] as const) {
    await assert.rejects(
      adapter.complete(attempt.credential, pending, address, async () => {}),
      { code: "PROVIDER_AUTHORIZATION_FAILED" },
    );
  }
  assert.equal(calls, 0);
});

test("identity mismatch and missing plan-use permission cannot become a connection", async () => {
  for (const missingScope of [true, false]) {
    const adapter = new OpenAiChatGptAuthorization(
      {
        /** Simulate a verified but different account when scopes are valid. */
        async verify() {
          return { subject: missingScope ? "original" : "different" };
        },
      },
      redirectUri,
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            id_token: "identity",
            token_type: "Bearer",
            expires_in: 3600,
            scope: missingScope
              ? "openid"
              : "resource.invoke chatgpt.tokens.use.direct",
          }),
        ),
    );
    const credential: ProviderCredential = {
      subject: "original",
      clientId: "issued-client",
    };
    const attempt = adapter.begin(credential);
    await assert.rejects(
      adapter.complete(
        credential,
        attempt.pending,
        callback(attempt.pending.state),
        async () => {},
      ),
      { code: "PROVIDER_AUTHORIZATION_FAILED" },
    );
  }
});
