import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type InjectOptions } from "fastify";
import { errorHandler } from "@everything/errors/fastify";
import { keyLimits } from "@everything/key-contracts";
import { isSshKeyMaterial } from "@everything/key-contracts/ssh";
import { SessionCipher } from "@everything/security/session-cipher";
import type { CredentialRollout } from "@everything/artifact-contracts/credential";
import { strictRequestValidation } from "../../http/config/request-validation.js";
import { keyController } from "../controller/key-controller.js";
import type { KeyRepository } from "../interface/key-repository.js";
import type { KeyActor } from "../model/key-actor.js";
import type { StoredKey } from "../model/stored-key.js";
import { KeyService } from "../service/key-service.js";

/** A value with characters most likely to be altered on the way. */
const sentinel =
  "  gc-sentinel-5d1e\nsecond line $HOME `id` \\ 'q' \"dq\" ü 🔑\r\n\t ";
const replacement = "gc-sentinel-replaced-77a0";
const owner: KeyActor = { subject: "owner" };
const other: KeyActor = { subject: "other-owner" };
const appToken: KeyActor = { subject: "owner", app: "app-id" };

/** In-memory records with the same rules as the PostgreSQL repository. */
function memoryKeys() {
  const records = new Map<string, StoredKey>();
  const repository: KeyRepository = {
    async list() {
      return [...records.values()];
    },
    async getById(_scope, id) {
      return records.get(id);
    },
    async create(scope, key) {
      assert.equal(key.ownerId, scope.actorId);
      if (
        key.type === "generic" &&
        [...records.values()].some(
          (record) =>
            record.type === "generic" &&
            !record.deletedAt &&
            record.name.toLowerCase() === key.name.toLowerCase(),
        )
      )
        throw Object.assign(new Error("taken"), { code: "KEY_NAME_TAKEN" });
      records.set(key.id, key);
    },
    async rename(_scope, id, name, description) {
      const key = records.get(id);
      if (!key || key.deletedAt) return undefined;
      const updated = {
        ...key,
        name,
        ...(description !== undefined ? { description } : {}),
      };
      records.set(id, updated);
      return updated;
    },
    async replaceMaterial(scope, id, encryptedMaterial) {
      const key = records.get(id);
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
    async markDeleted(_scope, id) {
      const key = records.get(id);
      if (key?.type === "generic" && !key.deletedAt)
        records.set(id, {
          ...key,
          encryptedMaterial: "",
          deletedAt: new Date().toISOString(),
        });
    },
    async delete(_scope, id) {
      records.delete(id);
    },
  };
  const cipher = new SessionCipher(Buffer.alloc(32, 9).toString("base64"));
  const service = new KeyService(
    repository,
    cipher,
    new Map([["ssh", { accepts: isSshKeyMaterial }]]),
  );
  return { records, cipher, service };
}

test("a generic credential is stored encrypted and exactly, and only metadata comes back", async () => {
  const { records, cipher, service } = memoryKeys();
  const saved = await service.create(owner, {
    name: "  slack-bot-token ",
    type: "generic",
    material: sentinel,
    description: "  Slack bot for #ops ",
  });
  assert.deepEqual(Object.keys(saved).sort(), [
    "createdAt",
    "description",
    "id",
    "name",
    "owned",
    "type",
    "updatedAt",
  ]);
  assert.equal(saved.name, "slack-bot-token");
  assert.equal(saved.description, "Slack bot for #ops");
  const stored = records.get(saved.id)!;
  assert.ok(!JSON.stringify(stored).includes("gc-sentinel"));
  assert.equal(await cipher.open(stored.encryptedMaterial), sentinel);
  assert.equal(stored.version, 1);
  assert.deepEqual(await service.list(other), [{ ...saved, owned: false }]);
});

test("only the account that added a credential can replace its value, and never an app's own token", async () => {
  const { records, cipher, service } = memoryKeys();
  const saved = await service.create(owner, {
    name: "token",
    type: "generic",
    material: sentinel,
  });
  await assert.rejects(
    service.replaceValue(other, saved.id, { material: replacement }),
    { code: "CREDENTIAL_OWNER_ONLY" },
  );
  await assert.rejects(
    service.replaceValue(appToken, saved.id, { material: replacement }),
    { code: "APP_CREDENTIAL_ACCESS_FORBIDDEN" },
  );
  const replaced = await service.replaceValue(owner, saved.id, {
    material: replacement,
  });
  assert.equal(replaced.id, saved.id);
  assert.equal(records.get(saved.id)!.version, 2);
  assert.equal(
    await cipher.open(records.get(saved.id)!.encryptedMaterial),
    replacement,
  );
  for (const actor of [appToken])
    for (const action of [
      () =>
        service.create(actor, {
          name: "new",
          type: "generic",
          material: "x-value",
        }),
      () => service.rename(actor, saved.id, { name: "renamed" }),
      () => service.delete(actor, saved.id),
    ])
      await assert.rejects(action(), {
        code: "APP_CREDENTIAL_ACCESS_FORBIDDEN",
      });
});

test("SSH keys can't be given a value replacement and keep their existing behavior", async () => {
  const { service } = memoryKeys();
  const ssh = await service.create(owner, {
    name: "deploy",
    type: "ssh",
    material:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF2PfL9O70J4hWd0uhqGnV7hbRXY86NbG0DGpZEL4S8x test@example",
  });
  assert.deepEqual(Object.keys(ssh).sort(), [
    "createdAt",
    "id",
    "name",
    "type",
  ]);
  await assert.rejects(
    service.replaceValue(owner, ssh.id, { material: replacement }),
    { code: "KEY_NOT_FOUND" },
  );
  // An app's own token keeps the existing installation-wide SSH key policy.
  await service.rename(appToken, ssh.id, { name: "renamed" });
  assert.equal(await service.delete(appToken, ssh.id), "ssh");
});

test("deleting a generic credential erases its value at once and keeps it listed as removing", async () => {
  const { records, service } = memoryKeys();
  const saved = await service.create(owner, {
    name: "token",
    type: "generic",
    material: sentinel,
  });
  assert.equal(await service.delete(other, saved.id), "generic");
  assert.equal(records.get(saved.id)!.encryptedMaterial, "");
  assert.ok(records.get(saved.id)!.deletedAt);
  assert.deepEqual(
    (await service.list(owner)).map((key) => key.status),
    ["removing"],
  );
  await assert.rejects(
    service.replaceValue(owner, saved.id, { material: replacement }),
    { code: "KEY_NOT_FOUND" },
  );
  await assert.rejects(service.rename(owner, saved.id, { name: "again" }), {
    code: "KEY_NOT_FOUND",
  });
});

test("blank, NUL, unpaired-surrogate, and oversized values are refused without being repeated", async () => {
  const { records, service } = memoryKeys();
  for (const material of [
    "   \n\t ",
    "gc-sentinel-nul\0tail",
    "gc-sentinel-\uD800",
    "é".repeat(keyLimits.materialLength / 2 + 1),
  ]) {
    const error = await service
      .create(owner, { name: "token", type: "generic", material })
      .then(
        () => assert.fail("accepted"),
        (failure: Error & { code: string }) => failure,
      );
    assert.equal(error.code, "INVALID_CREDENTIAL_VALUE");
    assert.ok(!error.message.includes("gc-sentinel"));
  }
  assert.equal(records.size, 0);
});

/** The key routes over a real service, authenticated as the subject and app in test headers. */
async function server(rollouts: CredentialRollout[] = []) {
  const keys = memoryKeys();
  const app = Fastify({ ajv: strictRequestValidation });
  app.setErrorHandler(errorHandler);
  app.decorateRequest("identity", null);
  app.addHook("onRequest", async (request) => {
    const app = request.headers["x-test-app"];
    request.identity = {
      subject: String(request.headers["x-test-subject"] ?? "owner"),
      ...(typeof app === "string" ? { app } : {}),
    };
  });
  const delivered: string[] = [];
  await keyController(app, keys.service, {
    rollouts: {
      deliver: async (_actor, id) => {
        delivered.push(`deliver:${id}`);
        return rollouts.shift() ?? { complete: true, usage: null };
      },
      revoke: async (_actor, id) => {
        delivered.push(`revoke:${id}`);
        return rollouts.shift() ?? { complete: true, usage: null };
      },
    },
    grants: { usage: async () => ({ apps: [], otherApps: 0 }) },
  });
  return { app, delivered, ...keys };
}

test("no key route ever answers with a credential value, including errors", async (context) => {
  const { app, delivered } = await server([
    {
      complete: false,
      usage: {
        apps: [
          {
            appId: "89bb2d67-090d-405a-84f8-880d9231c9c2",
            slug: "bot",
            title: "Bot",
            env: "SLACK_BOT_TOKEN",
            status: "pending",
          },
        ],
        otherApps: 1,
      },
    },
  ]);
  context.after(() => app.close());
  const bodies: string[] = [];
  const send = async (options: InjectOptions) => {
    const response = await app.inject(options);
    bodies.push(response.body);
    return response;
  };
  const created = await send({
    method: "POST",
    url: "/keys",
    payload: { name: "token", type: "generic", material: sentinel },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as string;
  await send({ url: "/keys" });
  await send({
    method: "PATCH",
    url: `/keys/${id}`,
    payload: { name: "renamed", description: "For the bot" },
  });
  const replaced = await send({
    method: "PUT",
    url: `/keys/${id}/value`,
    payload: { material: replacement },
  });
  assert.equal(replaced.statusCode, 200);
  assert.equal(replaced.json().rollout.complete, false);
  assert.equal(replaced.json().rollout.usage.otherApps, 1);
  const forbidden = await send({
    method: "PUT",
    url: `/keys/${id}/value`,
    headers: { "x-test-app": "app-id" },
    payload: { material: sentinel },
  });
  assert.equal(forbidden.statusCode, 403);
  const foreign = await send({
    method: "PUT",
    url: `/keys/${id}/value`,
    headers: { "x-test-subject": "other-owner" },
    payload: { material: sentinel },
  });
  assert.equal(foreign.statusCode, 403);
  for (const material of [
    "gc-sentinel-nul\0",
    "gc-sentinel-big".repeat(3000),
  ]) {
    const refused = await send({
      method: "POST",
      url: "/keys",
      payload: { name: "bad", type: "generic", material },
    });
    assert.equal(refused.statusCode, 400);
  }
  const removed = await send({ method: "DELETE", url: `/keys/${id}` });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().rollout.complete, true);
  assert.deepEqual(delivered, [`deliver:${id}`, `revoke:${id}`]);
  for (const body of bodies) {
    assert.ok(!body.includes("gc-sentinel"), body);
    assert.ok(!body.includes("encryptedMaterial"), body);
  }
});
