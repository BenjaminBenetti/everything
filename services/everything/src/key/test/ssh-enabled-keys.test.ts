import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedKey } from "@everything/key-contracts";
import type { KeyOperations } from "../interface/key-operations.js";
import { SshEnabledKeys } from "../service/ssh-enabled-keys.js";
import type { KeyActor } from "../model/key-actor.js";

const owner: KeyActor = { subject: "owner" };

test("SSH integration preserves actor attribution and waits for upload and deletion to converge", async () => {
  const key: SavedKey = {
    id: "one",
    name: "Development",
    type: "ssh",
    createdAt: "2026-10-16T00:00:00.000Z",
  };
  let exists = false;
  let loaded = false;
  let refreshes = 0;
  const operations: KeyOperations = {
    /** Preserve the authenticated actor on every delegated operation. */
    async list(actor) {
      assert.equal(actor, owner);
      return exists ? [key] : [];
    },
    /** Persist before synchronization can observe the key. */
    async create(actor) {
      assert.equal(actor, owner);
      exists = true;
      return key;
    },
    /** Change metadata without changing the secret pool. */
    async rename(actor, id, input) {
      assert.equal(actor, owner);
      assert.equal(id, key.id);
      return { ...key, name: input.name };
    },
    /** Delete before synchronization checks the authoritative pool. */
    /** Generic credentials never reach SSH, so this is unused here. */
    async replaceValue() {
      throw new Error("No value replacement expected");
    },
    async delete(actor, id) {
      assert.equal(actor, owner);
      assert.equal(id, key.id);
      exists = false;
      return "ssh";
    },
  };
  const service = new SshEnabledKeys(operations, {
    /** Simulate asynchronous convergence after each committed mutation. */
    async refresh() {
      await Promise.resolve();
      refreshes++;
      loaded = exists;
    },
    /** Expose only the convergence result. */
    status() {
      return loaded ? "ready" : "pending";
    },
  });
  const created = await service.create(owner, {
    name: key.name,
    type: "ssh",
    material: "private",
  });
  assert.equal(created.availability, "ready");
  assert.equal(JSON.stringify(created).includes("private"), false);
  assert.deepEqual(await service.list(owner), [created]);
  assert.equal(
    (await service.rename(owner, key.id, { name: "Renamed" })).availability,
    "ready",
  );
  assert.equal(refreshes, 1);
  await service.delete(owner, key.id);
  assert.equal(loaded, false);
  assert.equal(refreshes, 2);
});
