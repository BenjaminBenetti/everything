import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CredentialDelivery,
  CredentialInventoryEntry,
} from "@everything/artifact-contracts/credential";
import { SessionCipher } from "@everything/security/session-cipher";
import { ArtifactRequestFailure } from "../../artifact/error/artifact-errors.js";
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
        valueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
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
        valueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
        deletedAt: "2026-10-22T00:00:00.000Z",
      },
    ],
  ]);
  const calls: string[] = [];
  const failures: string[] = [];
  const inventory: CredentialInventoryEntry[] = [];
  const revocations: CredentialDelivery[] = [];
  /** The newest version and value the app service recorded, which it checks deliveries against. */
  const runtime = new Map<string, { version: number; valueId: string }>();
  let unreachable = false;
  const rollouts = new CredentialRollouts(
    {
      getById: async (_scope, id) => records.get(id),
      list: async () => [...records.values()],
      purge: async (id) => {
        calls.push(`purge:${id}`);
        if (records.get(id)?.deletedAt) records.delete(id);
      },
      advanceVersion: async (id, from, version) => {
        const record = records.get(id);
        if (
          !record ||
          record.deletedAt ||
          record.version !== from.version ||
          record.valueId !== from.valueId
        )
          return false;
        records.set(id, { ...record, version });
        calls.push(`advance:${id}:${version}`);
        return true;
      },
    },
    cipher,
    {
      deliverCredential: async (id, input) => {
        if (unreachable) throw new Error("connect ECONNREFUSED");
        const held = runtime.get(id);
        if (held && held.version > input.version)
          throw new ArtifactRequestFailure(
            409,
            "CREDENTIAL_SUPERSEDED",
            "Newer.",
          );
        if (held?.version === input.version && held.valueId !== input.valueId)
          throw new ArtifactRequestFailure(
            409,
            "CREDENTIAL_VALUE_CONFLICT",
            "Conflict.",
          );
        runtime.set(id, { version: input.version, valueId: input.valueId });
        calls.push(`deliver:${id}:${input.version}:${input.value}`);
        return { complete: true, apps: [] };
      },
      revokeCredential: async (id) => {
        if (unreachable) throw new Error("connect ECONNREFUSED");
        calls.push(`revoke:${id}`);
        return revocations.shift() ?? { complete: true, apps: [] };
      },
      credentialInventory: async () =>
        inventory.map((item) => ({
          ...item,
          version: runtime.get(item.credentialId)?.version ?? item.version,
          valueId: runtime.get(item.credentialId)?.valueId ?? item.valueId,
        })),
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
    runtime,
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
    version: null,
    valueId: null,
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

test("a value replaced after a database restore is saved past the version apps hold, never reported applied with the old value", async () => {
  const context = await fixture();
  // Apps hold version 4 of another value: Everything's database was restored, then replaced once.
  context.runtime.set(live, {
    version: 4,
    valueId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
  });
  context.inventory.push(entry(live, { oldestVersion: 4 }));
  const rollout = await context.rollouts.deliver({ subject: "owner" }, live);
  assert.equal(rollout.complete, true);
  assert.deepEqual(context.calls, [
    `advance:${live}:5`,
    `deliver:${live}:5:rollout-sentinel-v4`,
  ]);
  assert.equal(context.records.get(live)?.version, 5);
});

test("synchronization aligns apps that hold a newer version, without overwriting a concurrent replacement", async () => {
  const context = await fixture();
  context.records.delete(deleted);
  context.runtime.set(live, {
    version: 6,
    valueId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc6",
  });
  context.inventory.push(entry(live, { oldestVersion: 6 }));
  await context.rollouts.synchronize();
  assert.deepEqual(context.calls, [
    `advance:${live}:7`,
    `deliver:${live}:7:rollout-sentinel-v4`,
  ]);

  const racing = await fixture();
  racing.records.delete(deleted);
  racing.runtime.set(live, {
    version: 6,
    valueId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc6",
  });
  racing.inventory.push(entry(live, { oldestVersion: 6 }));
  // The value is replaced while synchronization works: the compare-and-set refuses to move it.
  const getById = racing.records.get.bind(racing.records);
  let reads = 0;
  racing.records.get = (id: string) => {
    const record = getById(id);
    reads += 1;
    return reads === 2 && record
      ? { ...record, valueId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4" }
      : record;
  };
  await racing.rollouts.synchronize();
  assert.ok(!racing.calls.some((call) => call.startsWith("advance:")));
  assert.deepEqual(racing.failures, ["delivery"]);
});
