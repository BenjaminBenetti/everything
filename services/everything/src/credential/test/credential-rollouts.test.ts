import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CredentialDelivery,
  CredentialInventoryEntry,
} from "@everything/artifact-contracts/credential";
import { SessionCipher } from "@everything/security/session-cipher";
import type { StoredKey } from "../../key/model/stored-key.js";
import { CredentialRollouts } from "../service/credential-rollouts.js";

const cipher = new SessionCipher(Buffer.alloc(32, 4).toString("base64"));
const live = "11111111-1111-4111-8111-111111111111";
const deleted = "22222222-2222-4222-8222-222222222222";
const forgotten = "33333333-3333-4333-8333-333333333333";

/** Rollouts over stored credentials and a scripted app service. */
async function fixture() {
  const records = new Map<string, StoredKey>([
    [
      live,
      {
        id: live,
        name: "token",
        ownerId: "owner",
        type: "generic",
        createdAt: "",
        updatedAt: "",
        encryptedMaterial: await cipher.seal("rollout-sentinel-v4"),
        description: null,
        version: 4,
        deletedAt: null,
      },
    ],
    [
      deleted,
      {
        id: deleted,
        name: "old",
        ownerId: "owner",
        type: "generic",
        createdAt: "",
        updatedAt: "",
        encryptedMaterial: "",
        description: null,
        version: 2,
        deletedAt: "2026-10-22T00:00:00.000Z",
      },
    ],
  ]);
  const calls: string[] = [];
  const failures: string[] = [];
  const inventory: CredentialInventoryEntry[] = [];
  const revocations: CredentialDelivery[] = [];
  let unreachable = false;
  const rollouts = new CredentialRollouts(
    {
      getById: async (_scope, id) => records.get(id),
      list: async () => [...records.values()],
      purge: async (id) => {
        calls.push(`purge:${id}`);
        if (records.get(id)?.deletedAt) records.delete(id);
      },
    },
    cipher,
    {
      deliverCredential: async (id, input) => {
        if (unreachable) throw new Error("connect ECONNREFUSED");
        calls.push(`deliver:${id}:${input.version}:${input.value}`);
        return { complete: true, apps: [] };
      },
      revokeCredential: async (id) => {
        if (unreachable) throw new Error("connect ECONNREFUSED");
        calls.push(`revoke:${id}`);
        return revocations.shift() ?? { complete: true, apps: [] };
      },
      credentialInventory: async () => inventory,
    },
    (task) => failures.push(task),
  );
  return {
    calls,
    failures,
    inventory,
    records,
    revocations,
    rollouts,
    unreachable: () => (unreachable = true),
  };
}

/** An inventory entry. */
function entry(
  credentialId: string,
  changes: Partial<CredentialInventoryEntry>,
): CredentialInventoryEntry {
  return {
    credentialId,
    oldestVersion: null,
    missing: false,
    held: false,
    revoked: false,
    ...changes,
  };
}

test("a replaced value is delivered as the stored version; an unreachable app service is reported, not hidden", async () => {
  const context = await fixture();
  const delivered = await context.rollouts.deliver({ subject: "owner" }, live);
  assert.deepEqual(delivered, {
    complete: true,
    usage: { apps: [], otherApps: 0 },
  });
  assert.deepEqual(context.calls, [`deliver:${live}:4:rollout-sentinel-v4`]);
  context.unreachable();
  assert.deepEqual(await context.rollouts.deliver({ subject: "owner" }, live), {
    complete: false,
    usage: null,
  });
  assert.deepEqual(context.failures, ["delivery"]);
});

test("a deleted credential is forgotten only once the app service reports nothing left to remove", async () => {
  const context = await fixture();
  context.revocations.push({
    complete: false,
    apps: [
      {
        ownerId: "owner",
        artifactId: "app",
        slug: "bot",
        title: "Bot",
        env: "TOKEN",
        version: 2,
        status: "removing",
      },
    ],
  });
  const pending = await context.rollouts.revoke({ subject: "owner" }, deleted);
  assert.equal(pending.complete, false);
  assert.equal(pending.usage?.apps[0]?.status, "removing");
  assert.ok(context.records.has(deleted));
  const done = await context.rollouts.revoke({ subject: "owner" }, deleted);
  assert.equal(done.complete, true);
  assert.ok(!context.records.has(deleted));
});

test("synchronization retries revocations, delivers outdated or missing values, and revokes what Everything forgot", async () => {
  const context = await fixture();
  context.inventory.push(
    entry(live, { oldestVersion: 3 }),
    entry(deleted, { oldestVersion: 2, held: true }),
    entry(forgotten, { oldestVersion: 1 }),
    entry("44444444-4444-4444-8444-444444444444", { revoked: true }),
  );
  await context.rollouts.synchronize();
  assert.deepEqual(context.calls, [
    `deliver:${live}:4:rollout-sentinel-v4`,
    `revoke:${deleted}`,
    `purge:${deleted}`,
    `revoke:${forgotten}`,
  ]);

  const current = await fixture();
  current.inventory.push(entry(live, { oldestVersion: 4 }));
  current.records.delete(deleted);
  await current.rollouts.synchronize();
  assert.deepEqual(
    current.calls,
    [],
    "nothing is resent while apps are current",
  );

  const missing = await fixture();
  missing.inventory.push(entry(live, { oldestVersion: 4, missing: true }));
  missing.records.delete(deleted);
  await missing.rollouts.synchronize();
  assert.deepEqual(missing.calls, [`deliver:${live}:4:rollout-sentinel-v4`]);
});

test("an undecryptable value is never sent and is reported to the caller", async () => {
  const context = await fixture();
  context.records.set(live, {
    ...context.records.get(live)!,
    encryptedMaterial: "corrupt",
  });
  await assert.rejects(context.rollouts.deliver({ subject: "owner" }, live), {
    code: "CREDENTIAL_UNAVAILABLE",
  });
  context.inventory.push(entry(live, { oldestVersion: 3 }));
  await context.rollouts.synchronize();
  assert.ok(!context.calls.some((call) => call.startsWith("deliver:")));
  assert.ok(context.failures.includes("delivery"));
});
