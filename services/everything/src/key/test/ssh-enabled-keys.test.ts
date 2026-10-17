import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedKey } from "@everything/key-contracts";
import type { KeyOperations } from "../interface/key-operations.js";
import { SshEnabledKeys } from "../service/ssh-enabled-keys.js";

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
    async list(owner) {
      assert.equal(owner, "owner");
      return exists ? [key] : [];
    },
    /** Persist before synchronization can observe the key. */
    async create(owner) {
      assert.equal(owner, "owner");
      exists = true;
      return key;
    },
    /** Change metadata without changing the secret pool. */
    async rename(owner, id, input) {
      assert.equal(owner, "owner");
      assert.equal(id, key.id);
      return { ...key, name: input.name };
    },
    /** Delete before synchronization checks the authoritative pool. */
    async delete(owner, id) {
      assert.equal(owner, "owner");
      assert.equal(id, key.id);
      exists = false;
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
  const created = await service.create("owner", {
    name: key.name,
    type: "ssh",
    material: "private",
  });
  assert.equal(created.availability, "ready");
  assert.equal(JSON.stringify(created).includes("private"), false);
  assert.deepEqual(await service.list("owner"), [created]);
  assert.equal(
    (await service.rename("owner", key.id, { name: "Renamed" })).availability,
    "ready",
  );
  assert.equal(refreshes, 1);
  await service.delete("owner", key.id);
  assert.equal(loaded, false);
  assert.equal(refreshes, 2);
});
