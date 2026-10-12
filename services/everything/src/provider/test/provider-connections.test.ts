import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionCipher } from "@everything/security/session-cipher";
import type { ProviderStore } from "../interface/provider-repository.js";
import type { ChatGptAuthorization } from "../interface/chatgpt-authorization.js";
import type {
  StoredProvider,
  ProviderCredential,
} from "../model/stored-provider.js";
import type { VerificationInput } from "../interface/connection-verifier.js";
import { ProviderConnectionService } from "../service/provider-connections.js";
import { providerLimits } from "@everything/provider-contracts";

/** Keep persistence outside a service instance so restart tests exercise restoration. */
function fixture() {
  const records = new Map<string, StoredProvider>();
  const cipher = new SessionCipher(Buffer.alloc(32, 3).toString("base64"));
  const store: ProviderStore = {
    /** Apply ownership to the fake database query. */
    async list({ ownerId }) {
      return [...records.values()].filter(
        (record) => record.ownerId === ownerId,
      );
    },
    /** Retain an independent copy of encrypted database records. */
    async save({ ownerId }, record) {
      assert.equal(ownerId, record.ownerId);
      records.set(record.id, structuredClone(record));
    },
    /** Missing and inaccessible identifiers behave identically. */
    async delete({ ownerId }, id) {
      if (records.get(id)?.ownerId === ownerId) records.delete(id);
    },
  };
  let failure = false;
  const inputs: VerificationInput[] = [];
  const verifier = {
    /** Simulate completed inference or an upstream error containing sensitive text. */
    async verify(input: VerificationInput) {
      inputs.push(input);
      if (failure) throw new Error("secret-test-key upstream body");
      return "test-model";
    },
  };
  const authorization: ChatGptAuthorization = {
    /** Prepare an owner-bound attempt without contacting a user account. */
    begin(credential) {
      return {
        credential: { ...credential, hostId: credential.hostId ?? "test-host" },
        pending: {
          state: "state",
          nonce: "nonce",
          verifier: "verifier",
          redirectUri: "http://127.0.0.1:8080/callback",
          clientId: "issued",
          expiresAt: Date.now() + 10000,
        },
        authorization: {
          url: "https://auth.openai.com/authorize?state=state",
          redirectUri: "http://127.0.0.1:8080/callback",
          expiresAt: new Date(Date.now() + 10000).toISOString(),
        },
      };
    },
    /** Yield tokens only after the registration has been persisted. */
    async complete(credential, _pending, _callback, retain) {
      await retain({ ...credential, clientId: "issued" });
      return {
        credential: {
          ...credential,
          accessToken: "access",
          refreshToken: "old-refresh",
          clientId: "issued",
        },
        account: "Test account",
      };
    },
    /** Rotate on each check to prove failures cannot discard a replacement token. */
    async refresh(credential) {
      return { ...credential, refreshToken: "new-refresh" };
    },
    /** Confirm remote revocation in the test protocol. */
    async revoke() {
      return true;
    },
  };
  /** Reconstruct the service against the same durable store. */
  function service() {
    return new ProviderConnectionService(
      store,
      cipher,
      { chatgpt: verifier, anthropic: verifier, "openai-compatible": verifier },
      authorization,
    );
  }
  return {
    records,
    cipher,
    inputs,
    service,
    fail: () => {
      failure = true;
    },
  };
}

test("encrypts credentials, restores after service restart, and isolates owners", async () => {
  const state = fixture();
  const saved = await state
    .service()
    .save("owner", "anthropic", { apiKey: "secret-test-key" });
  assert.equal(saved.status, "verified");
  assert.ok(!JSON.stringify(saved).includes("secret-test-key"));
  const record = [...state.records.values()][0]!;
  assert.ok(!record.encryptedCredential.includes("secret-test-key"));
  assert.ok(
    (await state.cipher.open(record.encryptedCredential)).includes(
      "secret-test-key",
    ),
  );
  assert.equal((await state.service().list("owner"))[1]?.status, "verified");
  assert.ok(
    (await state.service().list("outsider")).every(
      (provider) => !provider.configured,
    ),
  );
  await assert.rejects(state.service().verify("outsider", "anthropic"), {
    code: "PROVIDER_NOT_CONNECTED",
  });
  await state.service().disconnect("outsider", "anthropic");
  assert.equal(state.records.size, 1);
  await state.service().disconnect("owner", "anthropic");
  assert.equal(state.records.size, 0);
});

test("failed and stale checks cannot stay green, and failures never expose provider bodies", async () => {
  const state = fixture();
  await state
    .service()
    .save("owner", "anthropic", { apiKey: "secret-test-key" });
  const record = [...state.records.values()][0]!;
  state.records.set(record.id, {
    ...record,
    verifiedAt: new Date(
      Date.now() - providerLimits.verificationLifetimeMs - 1000,
    ),
  });
  assert.equal((await state.service().list("owner"))[1]?.status, "unverified");
  state.fail();
  const failed = await state.service().verify("owner", "anthropic");
  assert.equal(failed.status, "error");
  assert.equal(failed.verifiedAt, null);
  assert.ok(!JSON.stringify(failed).includes("secret-test-key"));
  assert.equal((await state.service().list("owner"))[1]?.status, "error");
});

test("a changed API destination never receives a previously saved key implicitly", async () => {
  const state = fixture();
  await state.service().save("owner", "openai-compatible", {
    baseUrl: "http://model.local/v1/",
    apiKey: "secret-test-key",
  });
  await state
    .service()
    .save("owner", "openai-compatible", { baseUrl: "http://model.local/v1" });
  assert.equal(state.inputs.at(-1)?.credential.apiKey, "secret-test-key");
  await assert.rejects(
    state.service().save("owner", "openai-compatible", {
      baseUrl: "http://different.local/v1",
    }),
    { code: "PROVIDER_INPUT_INVALID" },
  );
  assert.equal(state.inputs.length, 2);
  await state.service().save("owner", "openai-compatible", {
    baseUrl: "http://different.local/v1",
    apiKey: "",
  });
  assert.equal(state.inputs.at(-1)?.credential.apiKey, "");
  for (const baseUrl of [
    "file:///etc/passwd",
    "https://key@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/v1#fragment",
  ]) {
    await assert.rejects(
      state
        .service()
        .save("owner", "openai-compatible", { baseUrl, apiKey: "" }),
      { code: "PROVIDER_INPUT_INVALID" },
    );
  }
});

test("OAuth survives service recreation, rejects replay, and saves rotated tokens before a failed check", async () => {
  const state = fixture();
  await state.service().authorize("owner");
  const before = [...state.records.values()][0]!;
  assert.ok(
    before.encryptedPending && !before.encryptedPending.includes("verifier"),
  );
  assert.equal((await state.service().list("owner"))[0]?.configured, false);
  await assert.rejects(state.service().complete("outsider", "callback"), {
    code: "PROVIDER_AUTHORIZATION_FAILED",
  });
  state.fail();
  const result = await state.service().complete("owner", "callback");
  assert.equal(result.status, "error");
  await assert.rejects(state.service().complete("owner", "callback"), {
    code: "PROVIDER_AUTHORIZATION_FAILED",
  });
  const record = [...state.records.values()][0]!;
  const envelope = JSON.parse(
    await state.cipher.open(record.encryptedCredential),
  ) as { value: ProviderCredential };
  assert.equal(envelope.value.refreshToken, "new-refresh");
  await state.service().disconnect("owner", "chatgpt");
  const disconnected = [...state.records.values()][0]!;
  const cleared = JSON.parse(
    await state.cipher.open(disconnected.encryptedCredential),
  ) as { value: ProviderCredential };
  assert.equal(cleared.value.accessToken, undefined);
  assert.equal(cleared.value.refreshToken, undefined);
  assert.equal(cleared.value.hostId, "test-host");
  assert.equal(cleared.value.clientId, "issued");
});
