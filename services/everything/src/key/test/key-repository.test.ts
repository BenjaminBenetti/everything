import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DataSource,
  type FindManyOptions,
  type FindOptionsWhere,
  Not,
  IsNull,
} from "typeorm";
import { PostgresKeyRepository } from "../repository/postgres-key-repository.js";
import { KeyEntity } from "../schema/key-entity.js";
import type { StoredKey } from "../model/stored-key.js";
import { PostgresSshKeyRepository } from "../repository/postgres-ssh-key-repository.js";
import type { SshKeyScope } from "../model/ssh-key-scope.js";

test("the installation runtime requires its explicit scope and filters SSH keys in the database", async (context) => {
  const database = new DataSource({ type: "postgres", entities: [KeyEntity] });
  const orm = database.getRepository(KeyEntity);
  const calls: unknown[] = [];
  context.mock.method(
    orm,
    "find",
    async (options: FindManyOptions<StoredKey>) => {
      calls.push(options.where);
      return [];
    },
  );
  const repository = new PostgresSshKeyRepository(database);
  await repository.list({ usage: "installation-ssh" });
  assert.deepEqual(calls, [{ type: "ssh", ownerId: Not(IsNull()) }]);
  await assert.rejects(
    repository.list({} as SshKeyScope),
    /explicit installation scope/,
  );
  assert.equal(calls.length, 1);
});

test("database operations explicitly scope the shared installation and preserve creator attribution", async (context) => {
  const database = new DataSource({ type: "postgres", entities: [KeyEntity] });
  const orm = database.getRepository(KeyEntity);
  const calls: unknown[] = [];
  const record: StoredKey = {
    id: "key",
    ownerId: "owner",
    name: "Development",
    type: "ssh",
    createdAt: new Date().toISOString(),
    encryptedMaterial: "ciphertext",
    description: null,
    version: 1,
    valueId: null,
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
  context.mock.method(
    orm,
    "find",
    async (options: FindManyOptions<StoredKey>) => {
      calls.push(options.where);
      return [record];
    },
  );
  context.mock.method(
    orm,
    "findOneBy",
    async (where: FindOptionsWhere<StoredKey>) => {
      calls.push(where);
      return record;
    },
  );
  context.mock.method(
    orm,
    "update",
    async (where: FindOptionsWhere<StoredKey>, update: unknown) => {
      calls.push([where, update]);
      return { affected: 1 };
    },
  );
  context.mock.method(orm, "insert", async (value: StoredKey) => {
    calls.push(value);
  });
  const repository = new PostgresKeyRepository(database);
  const scope = { usage: "installation", actorId: "owner" } as const;
  await repository.list(scope);
  await repository.getById({ ...scope, actorId: "other" }, "key");
  await repository.rename({ ...scope, actorId: "other" }, "key", "Renamed");
  await repository.create(scope, record);
  assert.deepEqual(calls, [
    { ownerId: Not(IsNull()) },
    { ownerId: Not(IsNull()), id: "key" },
    [
      { ownerId: Not(IsNull()), id: "key", deletedAt: IsNull() },
      { name: "Renamed" },
    ],
    { ownerId: Not(IsNull()), id: "key" },
    record,
  ]);
  const count = calls.length;
  await assert.rejects(
    repository.create({ ...scope, actorId: "other" }, record),
    /creator mismatch/,
  );
  await assert.rejects(
    repository.create({ ...scope, actorId: "" }, record),
    /authenticated installation scope/,
  );
  await assert.rejects(
    repository.list({ ...scope, actorId: "" }),
    /authenticated installation scope/,
  );
  await assert.rejects(
    repository.getById({ ...scope, actorId: "" }, "key"),
    /authenticated installation scope/,
  );
  await assert.rejects(
    repository.rename({ ...scope, actorId: "" }, "key", "Renamed"),
    /authenticated installation scope/,
  );
  await assert.rejects(
    repository.delete({ ...scope, actorId: "" }, "key"),
    /authenticated installation scope/,
  );
  assert.equal(calls.length, count);
});
