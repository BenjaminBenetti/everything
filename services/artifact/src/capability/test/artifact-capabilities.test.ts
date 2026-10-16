import assert from "node:assert/strict";
import { test } from "node:test";
import { ProvisionedArtifactCapabilities } from "../service/artifact-capabilities.js";
import { EverythingApiCapability } from "../service/everything-api-capability.js";

test("capabilities inject exactly the requested app credentials, detect changes, and revoke on removal", async () => {
  const calls: string[] = [];
  let clientSecret = "app-secret-1";
  let written: Readonly<Record<string, string>> = {};
  const capability = new EverythingApiCapability(
    {
      /** Bind the provisioned client to the app's immutable ID and owner. */
      ensure: async (app, owner) => {
        assert.deepEqual([app, owner], ["app", "owner"]);
        calls.push("ensure-client");
        return { clientId: "app-client", clientSecret };
      },
      remove: async () => {
        calls.push("remove-client");
      },
    },
    {
      apiUrl: "http://everything:8080",
      tokenUrl: "http://keycloak:8080/token",
    },
  );
  const capabilities = new ProvisionedArtifactCapabilities([capability], {
    /** Store only the expected capability's credentials. */
    write: async (app, name, values) => {
      assert.deepEqual([app, name], ["app", "everything-api"]);
      calls.push("write-secret");
      written = values;
      return "app-api-secret";
    },
    remove: async () => {
      calls.push("remove-secret");
    },
  });
  const owner = { id: "app", ownerId: "owner" };
  const disabled = await capabilities.reconcile(owner, []);
  assert.deepEqual(disabled, { secretNames: [], fingerprint: null });
  assert.deepEqual(calls.splice(0), ["remove-client", "remove-secret"]);
  const enabled = await capabilities.reconcile(owner, ["everything-api"]);
  assert.deepEqual(written, {
    EVERYTHING_API_URL: "http://everything:8080",
    EVERYTHING_TOKEN_URL: "http://keycloak:8080/token",
    EVERYTHING_CLIENT_ID: "app-client",
    EVERYTHING_CLIENT_SECRET: "app-secret-1",
  });
  assert.deepEqual(enabled.secretNames, ["app-api-secret"]);
  assert.doesNotMatch(JSON.stringify(enabled), /app-secret-1/);
  assert.deepEqual(
    await capabilities.reconcile(owner, ["everything-api"]),
    enabled,
  );
  clientSecret = "app-secret-2";
  assert.notEqual(
    (await capabilities.reconcile(owner, ["everything-api"])).fingerprint,
    enabled.fingerprint,
  );
  await capabilities.remove(owner.id);
  assert.deepEqual(calls.slice(-2), ["remove-client", "remove-secret"]);
});

test("failed external revocation keeps credentials available for retry", async () => {
  const capabilities = new ProvisionedArtifactCapabilities(
    [
      {
        name: "everything-api",
        ensure: async () => ({}),
        remove: async () => {
          throw new Error("unavailable");
        },
      },
    ],
    {
      write: async () => "secret",
      remove: async () => assert.fail("must retain the Secret"),
    },
  );
  await assert.rejects(
    capabilities.reconcile({ id: "app", ownerId: "owner" }, []),
    /unavailable/,
  );
  await assert.rejects(capabilities.remove("app"), /unavailable/);
});
