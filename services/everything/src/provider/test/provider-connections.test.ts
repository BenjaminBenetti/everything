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
    verifier,
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
  assert.equal(
    saved.lastCheckedAt,
    [...state.records.values()][0]!.lastCheckedAt?.toISOString(),
  );
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
  await assert.rejects(state.service().access("owner", "anthropic"), {
    code: "PROVIDER_INACTIVE",
  });
});

test("elapsed time preserves connection status, while failed checks revoke access without exposing provider bodies", async () => {
  const state = fixture();
  await state
    .service()
    .save("owner", "anthropic", { apiKey: "secret-test-key" });
  const record = [...state.records.values()][0]!;
  state.records.set(record.id, {
    ...record,
    verifiedAt: new Date(
      Date.now() - providerLimits.verificationIntervalMs - 1000,
    ),
  });
  assert.equal((await state.service().list("owner"))[1]?.status, "verified");
  assert.equal(
    (await state.service().access("owner", "anthropic")).credential.apiKey,
    "secret-test-key",
  );
  await assert.rejects(state.service().access("outsider", "anthropic"), {
    code: "PROVIDER_INACTIVE",
  });
  state.fail();
  const failed = await state.service().verify("owner", "anthropic");
  assert.equal(failed.status, "error");
  assert.equal(failed.verifiedAt, null);
  assert.ok(failed.lastCheckedAt);
  assert.ok(!JSON.stringify(failed).includes("secret-test-key"));
  assert.equal((await state.service().list("owner"))[1]?.status, "error");
  await assert.rejects(state.service().access("owner", "anthropic"), {
    code: "PROVIDER_INACTIVE",
  });
});

test("automatic checks respect the persisted 24-hour boundary across concurrent calls and restarts", async (context) => {
  const start = new Date("2026-01-01T00:00:00Z").getTime();
  context.mock.timers.enable({ apis: ["Date"], now: start });
  const state = fixture();
  const service = state.service();
  const saved = await service.save("owner", "openai-compatible", {
    baseUrl: "http://model.local/v1",
    apiKey: "secret-test-key",
  });
  assert.equal(providerLimits.verificationIntervalMs, 24 * 60 * 60 * 1000);
  context.mock.timers.setTime(
    start + providerLimits.verificationIntervalMs - 1,
  );
  await service.verifyIfDue("owner", "openai-compatible");
  assert.equal(state.inputs.length, 1);
  assert.equal(
    (await service.list("owner"))[2]?.lastCheckedAt,
    saved.lastCheckedAt,
  );
  context.mock.timers.setTime(start + providerLimits.verificationIntervalMs);
  await Promise.all(
    Array.from({ length: 5 }, () =>
      service.verifyIfDue("owner", "openai-compatible"),
    ),
  );
  assert.equal(state.inputs.length, 2);
  assert.equal(
    (await service.list("owner"))[2]?.lastCheckedAt,
    new Date().toISOString(),
  );
  await state.service().verifyIfDue("owner", "openai-compatible");
  await state.service().verifyIfDue("outsider", "openai-compatible");
  assert.equal(state.inputs.length, 2);
  await service.disconnect("owner", "openai-compatible");
  context.mock.timers.setTime(
    start + 2 * providerLimits.verificationIntervalMs,
  );
  await service.verifyIfDue("owner", "openai-compatible");
  assert.equal(state.inputs.length, 2);
});

test("failed automatic checks retain their attempt time and wait a day before retrying", async (context) => {
  const start = new Date("2026-01-01T00:00:00Z").getTime();
  context.mock.timers.enable({ apis: ["Date"], now: start });
  const state = fixture();
  await state
    .service()
    .save("owner", "anthropic", { apiKey: "secret-test-key" });
  state.fail();
  context.mock.timers.setTime(start + providerLimits.verificationIntervalMs);
  await state.service().verifyIfDue("owner", "anthropic");
  const failed = (await state.service().list("owner"))[1]!;
  assert.equal(failed.status, "error");
  assert.equal(failed.lastCheckedAt, new Date().toISOString());
  await state.service().verifyIfDue("owner", "anthropic");
  assert.equal(state.inputs.length, 2);
  context.mock.timers.setTime(
    start + 2 * providerLimits.verificationIntervalMs,
  );
  await state.service().verifyIfDue("owner", "anthropic");
  assert.equal(state.inputs.length, 3);
});

test("a pending daily refresh keeps the previous successful result visible and records the attempt first", async (context) => {
  const state = fixture();
  const service = state.service();
  await service.save("owner", "anthropic", { apiKey: "secret-test-key" });
  const record = [...state.records.values()][0]!;
  state.records.set(record.id, { ...record, lastCheckedAt: null });
  let begin!: () => void;
  let finish!: (model: string) => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const result = new Promise<string>((resolve) => {
    finish = resolve;
  });
  context.mock.method(state.verifier, "verify", async () => {
    begin();
    return result;
  });
  const refresh = service.verifyIfDue("owner", "anthropic");
  await started;
  const pending = (await service.list("owner"))[1]!;
  assert.equal(pending.status, "verified");
  assert.equal(pending.verifiedAt, record.verifiedAt?.toISOString());
  assert.ok(pending.lastCheckedAt);
  finish("test-model");
  await refresh;
  assert.equal((await state.service().list("owner"))[1]?.status, "verified");
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
