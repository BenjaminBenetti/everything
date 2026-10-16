import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { MessageEntity } from "../schema/message-entity.js";
import { PostgresMessageRepository } from "../repository/postgres-message-repository.js";
import { ConversationSearchService } from "../service/conversation-search-service.js";

/** Tests own a random database on an explicitly configured disposable PostgreSQL server. */
const serverUrl = process.env.CONVERSATION_SEARCH_TEST_DATABASE_URL;

test(
  "PostgreSQL search matches literal chat, isolates owners and teammates, pages tied timestamps, and survives reconnecting",
  { skip: !serverUrl },
  async () => {
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    const name = `conversation_search_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const address = new URL(serverUrl!);
    address.pathname = `/${name}`;
    const settings = {
      databaseUrl: address.href,
      databasePassword: decodeURIComponent(address.password),
    };
    let database = createApplicationDatabase(settings);
    try {
      await database.initialize();
      await database.runMigrations();
      const agentId = randomUUID();
      const otherTeammate = randomUUID();
      const otherOwner = randomUUID();
      await database.getRepository(AgentEntity).insert([
        { id: agentId, ownerId: "owner", name: "Zip", systemPrompt: "Help" },
        {
          id: otherTeammate,
          ownerId: "owner",
          name: "Other",
          systemPrompt: "Help",
        },
        {
          id: otherOwner,
          ownerId: "another-owner",
          name: "Other owner",
          systemPrompt: "Help",
        },
      ]);
      const records = [
        {
          id: randomUUID(),
          agentId,
          role: "user" as const,
          text: "Doorbell: use the wakeup endpoint",
        },
        {
          id: randomUUID(),
          agentId: otherTeammate,
          role: "user" as const,
          text: "Doorbell in a different conversation",
        },
        {
          id: randomUUID(),
          agentId,
          role: "assistant" as const,
          text: "Yes, one click should ring once",
        },
        {
          id: randomUUID(),
          agentId: otherOwner,
          role: "user" as const,
          text: "Doorbell owned by someone else",
        },
        {
          id: randomUUID(),
          agentId,
          role: "user" as const,
          text: "Keep the literal 50%_\\ path and O'Reilly",
        },
        {
          id: randomUUID(),
          agentId,
          role: "assistant" as const,
          text: "The DOORBELL is ready",
        },
        {
          id: randomUUID(),
          agentId,
          role: "user" as const,
          text: "doorbell looks good",
        },
      ].map((record) => ({ ...record, createdAt: "2026-10-01T12:00:00.000Z" }));
      for (const record of records)
        await database.getRepository(MessageEntity).insert(record);
      let repository = new PostgresMessageRepository(database);
      let service = new ConversationSearchService(repository);
      const scope = { ownerId: "owner", agentId };
      const first = await service.search(scope, {
        query: "DOORBELL",
        limit: 2,
      });
      assert.deepEqual(
        first.matches.map((match) => match.message.id),
        [records[6]!.id, records[5]!.id],
      );
      assert.equal(first.nextCursor, records[5]!.id);
      assert.equal(first.matches[0]!.after, null);
      assert.equal(first.matches[1]!.before!.id, records[4]!.id);
      const second = await service.search(scope, {
        query: "doorbell",
        limit: 2,
        before: first.nextCursor!,
      });
      assert.deepEqual(
        second.matches.map((match) => match.message.id),
        [records[0]!.id],
      );
      assert.equal(second.nextCursor, null);
      assert.equal(second.matches[0]!.before, null);
      assert.equal(
        second.matches[0]!.after!.id,
        records[2]!.id,
        "Context skips other conversations even when their messages interleave",
      );
      assert.deepEqual(
        (
          await service.search(scope, { query: "doorbell", role: "assistant" })
        ).matches.map((match) => match.message.id),
        [records[5]!.id],
      );
      for (const query of ["50%_\\", "%", "_", "\\", "O'Reilly"]) {
        assert.deepEqual(
          (await service.search(scope, { query })).matches.map(
            (match) => match.message.id,
          ),
          [records[4]!.id],
        );
      }
      assert.deepEqual(
        (await service.search(scope, { query: "does not exist" })).matches,
        [],
      );
      for (const before of [records[1]!.id, records[3]!.id, randomUUID()]) {
        assert.deepEqual(
          await service.search(scope, { query: "doorbell", before }),
          { query: "doorbell", matches: [], nextCursor: null },
        );
        assert.deepEqual(await repository.neighbors(scope, before), {
          before: null,
          after: null,
        });
      }
      for (const foreignScope of [
        { ownerId: "another-owner", agentId },
        { ownerId: "owner", agentId: otherOwner },
      ]) {
        assert.deepEqual(
          (await service.search(foreignScope, { query: "doorbell" })).matches,
          [],
        );
        assert.deepEqual(
          await repository.neighbors(foreignScope, records[0]!.id),
          { before: null, after: null },
        );
      }
      assert.doesNotMatch(
        JSON.stringify(first),
        /sequence|ownerId|agentId|different conversation|someone else/,
      );
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      repository = new PostgresMessageRepository(database);
      service = new ConversationSearchService(repository);
      assert.deepEqual(
        await service.search(scope, { query: "DOORBELL", limit: 2 }),
        first,
      );
    } finally {
      if (database.isInitialized) await database.destroy();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
