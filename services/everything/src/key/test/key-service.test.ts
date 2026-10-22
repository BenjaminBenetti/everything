import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { SessionCipher } from "@everything/security/session-cipher";
import { keyLimits } from "@everything/key-contracts";
import { isSshKeyMaterial } from "@everything/key-contracts/ssh";
import type { StoredKey } from "../model/stored-key.js";
import type { KeyRepository } from "../interface/key-repository.js";
import { KeyService } from "../service/key-service.js";
import type { KeyActor } from "../model/key-actor.js";

const owner: KeyActor = { subject: "owner" };
const otherOwner: KeyActor = { subject: "other-owner" };

const material = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
  .trim();

/** Keep encrypted records independent of the service lifecycle. */
function fixture() {
  const records = new Map<string, StoredKey>();
  const repository: KeyRepository = {
    /** Every authenticated member sees the installation's records. */
    async list(scope) {
      assert.equal(scope.usage, "installation");
      assert.ok(scope.actorId);
      return [...records.values()];
    },
    /** Look up within the shared installation scope. */
    async getById(scope, id) {
      assert.equal(scope.usage, "installation");
      assert.ok(scope.actorId);
      return records.get(id);
    },
    /** Assert that the persistence boundary never receives plaintext. */
    async create({ actorId }, key) {
      assert.equal(key.ownerId, actorId);
      assert.equal(JSON.stringify(key).includes(material), false);
      records.set(key.id, structuredClone(key));
    },
    /** Rename a record selected within the installation. */
    async rename(scope, id, name, description) {
      const key = await this.getById(scope, id);
      if (!key || key.deletedAt) return undefined;
      const updated = {
        ...key,
        name,
        ...(description !== undefined ? { description } : {}),
      };
      records.set(id, updated);
      return updated;
    },
    /** Store a new value as the next version for the creator only. */
    async replaceMaterial(scope, id, encryptedMaterial) {
      const key = await this.getById(scope, id);
      if (
        !key ||
        key.type !== "generic" ||
        key.deletedAt ||
        key.ownerId !== scope.actorId
      )
        return undefined;
      const updated = {
        ...key,
        encryptedMaterial,
        version: key.version + 1,
        updatedAt: new Date().toISOString(),
      };
      records.set(id, updated);
      return updated;
    },
    /** Erase a generic credential's value and mark it deleted. */
    async markDeleted(scope, id) {
      const key = await this.getById(scope, id);
      if (key?.type === "generic" && !key.deletedAt)
        records.set(id, {
          ...key,
          encryptedMaterial: "",
          deletedAt: new Date().toISOString(),
        });
    },
    /** Missing records already satisfy deletion. */
    async delete(scope, id) {
      if (await this.getById(scope, id)) records.delete(id);
    },
  };
  const cipher = new SessionCipher(Buffer.alloc(32, 7).toString("base64"));
  /** Reconstruct the application with the same durable records and encryption configuration. */
  function service() {
    return new KeyService(
      repository,
      cipher,
      new Map([["ssh", { accepts: isSshKeyMaterial }]]),
    );
  }
  return { records, cipher, service, repository };
}

test("keys encrypt before persistence, return metadata only, and survive service recreation", async () => {
  const state = fixture();
  const saved = await state
    .service()
    .create(owner, { name: "  Development  ", type: "ssh", material });
  assert.deepEqual(Object.keys(saved).sort(), [
    "createdAt",
    "id",
    "name",
    "type",
  ]);
  assert.equal(saved.name, "Development");
  const stored = state.records.get(saved.id)!;
  assert.notEqual(stored.encryptedMaterial, material);
  assert.equal(await state.cipher.open(stored.encryptedMaterial), material);
  assert.deepEqual(await state.service().list(owner), [saved]);
  const another = await state
    .service()
    .create(owner, { name: "Another", type: "ssh", material });
  assert.notEqual(
    state.records.get(another.id)!.encryptedMaterial,
    stored.encryptedMaterial,
  );
  const renamed = await state
    .service()
    .rename(owner, saved.id, { name: "Renamed" });
  assert.deepEqual(renamed, { ...saved, name: "Renamed" });
  assert.equal(
    state.records.get(saved.id)!.encryptedMaterial,
    stored.encryptedMaterial,
  );
});

test("installation members share listing, renaming and deletion while creator attribution survives restart", async () => {
  const state = fixture();
  const saved = await state
    .service()
    .create(owner, { name: "Shared", type: "ssh", material });
  const service = state.service();
  assert.deepEqual(await service.list(otherOwner), [saved]);
  const renamed = await service.rename(otherOwner, saved.id, {
    name: "Changed",
  });
  assert.deepEqual(await service.list(owner), [renamed]);
  assert.equal(state.records.get(saved.id)?.ownerId, "owner");
  await assert.rejects(
    service.rename(otherOwner, "missing", { name: "Changed" }),
    { code: "KEY_NOT_FOUND" },
  );
  await service.delete(otherOwner, saved.id);
  assert.deepEqual(await service.list(owner), []);
  await service.delete(owner, saved.id);
});

test("rejects invalid uploads without retaining plaintext or echoing it in errors", async () => {
  const state = fixture();
  for (const input of [
    {
      name: "Key",
      type: "ssh" as const,
      material: "not-a-key-sensitive-content",
    },
    {
      name: "Key",
      type: "ssh" as const,
      material: "x".repeat(keyLimits.materialLength + 1),
    },
    { name: " ", type: "ssh" as const, material },
    {
      name: "x".repeat(keyLimits.nameLength + 1),
      type: "ssh" as const,
      material,
    },
  ])
    await assert.rejects(state.service().create(owner, input), {
      code: "INVALID_KEY",
    });
  assert.equal(state.records.size, 0);
});

test("format recognition supports encrypted PEM and OpenSSH envelopes without attempting decryption", () => {
  const encrypted = generateKeyPairSync("ed25519")
    .privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-only-passphrase",
    })
    .toString();
  assert.equal(isSshKeyMaterial(encrypted), true);
  assert.equal(isSshKeyMaterial(material.replaceAll("\n", "\r\n")), true);
  assert.equal(
    isSshKeyMaterial(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    ),
    true,
  );
  assert.equal(
    isSshKeyMaterial(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF2PfL9O70J4hWd0uhqGnV7hbRXY86NbG0DGpZEL4S8x test@example",
    ),
    true,
  );
  assert.equal(
    isSshKeyMaterial(material.replace("END PRIVATE", "END RSA PRIVATE")),
    false,
  );
  assert.equal(
    isSshKeyMaterial("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----"),
    false,
  );
  assert.equal(isSshKeyMaterial("ssh-ed25519 not-base64!"), false);
});
