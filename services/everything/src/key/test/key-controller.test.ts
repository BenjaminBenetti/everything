import assert from "node:assert/strict";
import { test } from "node:test";
import { keyLimits } from "@everything/key-contracts";
import { keyController } from "../controller/key-controller.js";
import type { KeyOperations } from "../interface/key-operations.js";
import { authenticatedTestServer } from "../../http/test/test-server.js";

/** Credential rollouts and usage, unused by SSH key routes. */
const unusedCredentials = {
  rollouts: {
    deliver: async () => assert.fail("No delivery expected"),
    revoke: async () => assert.fail("No revocation expected"),
  },
  grants: { usage: async () => assert.fail("No usage expected") },
};

test("key routes derive actor attribution from authentication and serialize metadata only", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const calls: unknown[] = [];
  const key = {
    id: "ab20ee89-3f13-44ab-a89a-c6b4ae1c07aa",
    createdAt: new Date().toISOString(),
    name: "Development",
    type: "ssh" as const,
  };
  const operations: KeyOperations = {
    /** Simulate a careless implementation to exercise the response allowlist. */
    async list(owner) {
      calls.push(owner.subject);
      return [
        {
          ...key,
          encryptedMaterial: "secret-ciphertext",
          material: "secret-plaintext",
          ownerId: owner.subject,
        },
      ];
    },
    /** Record only inputs that pass request validation. */
    async create(owner, input) {
      calls.push([owner.subject, input]);
      return key;
    },
    /** Record authenticated shared rename requests. */
    async rename(owner, id, input) {
      calls.push([owner.subject, id, input]);
      return { ...key, name: input.name };
    },
    /** Value replacement is covered by the generic credential tests. */
    async replaceValue() {
      throw new Error("No value replacement expected");
    },
    /** Record authenticated shared deletion requests. */
    async delete(owner, id) {
      calls.push([owner.subject, id]);
      return "ssh";
    },
  };
  await keyController(app, operations, unusedCredentials);
  const list = await app.inject("/keys");
  assert.deepEqual(list.json(), { keys: [key] });
  const input = { name: key.name, type: "ssh", material: "uploaded-only" };
  const created = await app.inject({
    method: "POST",
    url: "/keys",
    payload: input,
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), key);
  assert.deepEqual(calls, ["owner", ["owner", input]]);
  const renamed = await app.inject({
    method: "PATCH",
    url: `/keys/${key.id}`,
    payload: { name: "Renamed" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().name, "Renamed");
  assert.equal(
    (await app.inject({ method: "DELETE", url: `/keys/${key.id}` })).statusCode,
    204,
  );
  assert.deepEqual(calls.slice(2), [
    ["owner", key.id, { name: "Renamed" }],
    ["owner", key.id],
  ]);
  const count = calls.length;
  for (const payload of [
    { ...input, ownerId: "someone-else" },
    { ...input, type: "unknown" },
    { ...input, name: " " },
    { ...input, material: "" },
    { ...input, material: "x".repeat(keyLimits.materialLength + 1) },
  ])
    assert.equal(
      (await app.inject({ method: "POST", url: "/keys", payload })).statusCode,
      400,
    );
  for (const payload of [
    {},
    { name: " " },
    { name: "Rename", material: "replacement" },
    { name: "Rename", type: "ssh" },
  ]) {
    assert.equal(
      (await app.inject({ method: "PATCH", url: `/keys/${key.id}`, payload }))
        .statusCode,
      400,
    );
  }
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/keys/not-a-uuid" }))
      .statusCode,
    400,
  );
  assert.equal(calls.length, count);
});
