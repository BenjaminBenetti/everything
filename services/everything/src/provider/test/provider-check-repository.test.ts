import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DataSource,
  IsNull,
  LessThanOrEqual,
  Or,
  type FindManyOptions,
} from "typeorm";
import { ProviderEntity } from "../schema/provider-entity.js";
import { PostgresProviderCheckRepository } from "../repository/postgres-provider-check-repository.js";
import type { StoredProvider } from "../model/stored-provider.js";

test("maintenance reads apply configured state and due time in the database and return no credentials", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [ProviderEntity],
  });
  const cutoff = new Date("2026-01-01T00:00:00Z");
  const calls: FindManyOptions<StoredProvider>[] = [];
  context.mock.method(
    database.getRepository(ProviderEntity),
    "find",
    async (options: FindManyOptions<StoredProvider>) => {
      calls.push(options);
      return [
        {
          id: "connection",
          ownerId: "owner",
          createdAt: "2025-01-01",
          provider: "anthropic",
          encryptedCredential: "encrypted-secret",
        },
      ];
    },
  );
  const repository = new PostgresProviderCheckRepository(database);
  assert.deepEqual(await repository.list({ checkedBefore: cutoff }), [
    {
      id: "connection",
      ownerId: "owner",
      createdAt: "2025-01-01",
      provider: "anthropic",
    },
  ]);
  assert.deepEqual(calls[0]?.where, {
    configured: true,
    lastCheckedAt: Or(IsNull(), LessThanOrEqual(cutoff)),
  });
  assert.equal(calls[0]?.take, 20);
  await assert.rejects(
    repository.list({ checkedBefore: new Date("invalid") }),
    /scheduling cutoff/,
  );
  assert.equal(calls.length, 1);
});
