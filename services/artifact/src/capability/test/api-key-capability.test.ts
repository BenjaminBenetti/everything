import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiKeyCapability } from "../service/api-key-capability.js";
import { ProvisionedArtifactCapabilities } from "../service/artifact-capabilities.js";
import { HashedAppApiKeyStore } from "../service/hashed-app-api-key-store.js";
import { appApiKeyHash } from "../model/app-api-key.js";
import {
  MemoryAppApiKeyRecords,
  MemoryCapabilitySecrets,
} from "./api-key-fixture.js";

const owner = { id: "app", ownerId: "owner" };
const scope = { ownerId: "owner", artifactId: "app" };

/** The capability over in-memory records and Secrets; calling it again simulates a restart. */
function capabilities(
  records = new MemoryAppApiKeyRecords(),
  secrets = new MemoryCapabilitySecrets(),
) {
  const store = new HashedAppApiKeyStore(records, secrets);
  return {
    records,
    secrets,
    store,
    reconciler: new ProvisionedArtifactCapabilities(
      [new ApiKeyCapability(store)],
      secrets,
    ),
    /** The key reconciliation wrote to the app's Secret. */
    key: () => secrets.secrets.get("app-api-key")?.APP_API_KEY,
  };
}

test("enabling stores only a hash and gives the backend a stable key through its Secret", async () => {
  const { records, secrets, store, reconciler, key } = capabilities();
  const enabled = await reconciler.reconcile(owner, ["api-key"]);
  const first = key()!;
  assert.match(first, /^everything_app_key_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(enabled.secretNames, ["app-api-key"]);
  assert.deepEqual(Object.keys(secrets.secrets.get("app-api-key")!), [
    "APP_API_KEY",
  ]);
  assert.deepEqual(
    records.records.map((record) => record.keyHash),
    [appApiKeyHash(first)],
  );
  assert.doesNotMatch(
    JSON.stringify([records.records, enabled]),
    new RegExp(first),
  );
  assert.equal(await store.verifies(scope, first), true);
  assert.equal(await store.current(scope), first);

  assert.deepEqual(await reconciler.reconcile(owner, ["api-key"]), enabled);
  const restarted = capabilities(records, secrets);
  assert.deepEqual(
    await restarted.reconciler.reconcile(owner, ["api-key"]),
    enabled,
    "a restart keeps the key and does not roll the pod",
  );
  assert.equal(key(), first);
});

test("disabling revokes the key, and enabling it again creates a different one", async () => {
  const { records, secrets, store, reconciler, key } = capabilities();
  await reconciler.reconcile(owner, ["api-key"]);
  const first = key()!;
  assert.deepEqual(await reconciler.reconcile(owner, []), {
    secretNames: [],
    fingerprint: null,
  });
  assert.deepEqual([records.records, secrets.secrets.size], [[], 0]);
  assert.equal(await store.verifies(scope, first), false);
  assert.equal(await store.current(scope), undefined);

  const reenabled = await reconciler.reconcile(owner, ["api-key"]);
  assert.notEqual(key(), first);
  assert.equal(await store.verifies(scope, first), false);
  assert.equal(await store.verifies(scope, key()!), true);
  assert.ok(reenabled.fingerprint);

  await reconciler.remove(owner);
  assert.deepEqual([records.records, secrets.secrets.size], [[], 0]);
});

test("a reconcile after revocation can only create a new key, never restore the revoked one", async () => {
  const { store, reconciler, key } = capabilities();
  await reconciler.reconcile(owner, ["api-key"]);
  const revoked = key()!;
  // A deployment turning the key off revokes it first; a reconcile that still sees the old setting
  // then runs before the Secret is removed.
  await store.revoke(scope);
  await reconciler.reconcile(owner, ["api-key"]);
  assert.notEqual(key(), revoked);
  assert.equal(await store.verifies(scope, revoked), false);
  assert.equal(await store.current(scope), key());
});

test("a Secret and record that disagree never reveal or verify a stale key, and reconciliation repairs them", async () => {
  const { secrets, store, reconciler, key } = capabilities();
  await reconciler.reconcile(owner, ["api-key"]);
  const first = key()!;

  // The Secret write fails after a new record was saved.
  await store.revoke(scope);
  secrets.failWrites = true;
  await assert.rejects(
    reconciler.reconcile(owner, ["api-key"]),
    /the cluster is unavailable/,
  );
  assert.equal(key(), first, "the Secret still holds the old key");
  assert.equal(await store.verifies(scope, first), false);
  assert.equal(await store.current(scope), undefined, "nothing is revealed");
  secrets.failWrites = false;
  await reconciler.reconcile(owner, ["api-key"]);
  const repaired = key()!;
  assert.notEqual(repaired, first);
  assert.equal(await store.current(scope), repaired);

  // The Secret disappears outside the service.
  secrets.secrets.clear();
  assert.equal(await store.current(scope), undefined);
  await reconciler.reconcile(owner, ["api-key"]);
  assert.notEqual(key(), repaired);
  assert.equal(await store.verifies(scope, repaired), false);
  assert.equal(await store.verifies(scope, key()!), true);
});

test("records are limited to their owner's app", async () => {
  const records = new MemoryAppApiKeyRecords();
  const { store, reconciler, key } = capabilities(records);
  await reconciler.reconcile(owner, ["api-key"]);
  const other = { ownerId: "someone-else", artifactId: "app" };
  assert.equal(await store.verifies(other, key()!), false);
  assert.equal(await store.current(other), undefined);
  await store.revoke(other);
  assert.equal(await store.verifies(scope, key()!), true);
  await assert.rejects(store.replace(other, key()!), /unique/);
});
