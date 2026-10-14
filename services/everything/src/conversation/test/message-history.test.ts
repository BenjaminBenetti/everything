import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DataSource,
  LessThan,
  type FindManyOptions,
  type FindOptionsWhere,
} from "typeorm";
import { messagePageSize } from "@everything/conversation-contracts";
import { MessageEntity } from "../schema/message-entity.js";
import { PostgresMessageRepository } from "../repository/postgres-message-repository.js";
import type { MessageRecord } from "../model/message-record.js";

test("history pages use scoped insertion cursors, preserve tied timestamps, and exclude internal fields", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [MessageEntity],
  });
  const orm = database.getRepository(MessageEntity);
  const records: MessageRecord[] = Array.from({ length: 205 }, (_, index) => ({
    id: `message-${index + 1}`,
    agentId: "teammate",
    role: "user",
    text: String(index + 1),
    sequence: String(index + 1),
    readAt: null,
    createdAt: "2026-10-12T00:00:00Z",
  }));
  let upperBound = 206;
  context.mock.method(
    orm,
    "findOneBy",
    async (where: FindOptionsWhere<MessageRecord>) => {
      assert.deepEqual(where, {
        agentId: "teammate",
        agent: { ownerId: "owner" },
        id: `message-${upperBound}`,
      });
      return records.find((record) => record.id === where.id);
    },
  );
  context.mock.method(
    orm,
    "find",
    async (options: FindManyOptions<MessageRecord>) => {
      assert.deepEqual(options, {
        where: {
          agentId: "teammate",
          agent: { ownerId: "owner" },
          ...(upperBound < 206
            ? { sequence: LessThan(String(upperBound)) }
            : {}),
        },
        order: { sequence: "DESC" },
        take: messagePageSize + 1,
      });
      return records
        .filter((record) => Number(record.sequence) < upperBound)
        .reverse()
        .slice(0, messagePageSize + 1);
    },
  );
  const repository = new PostgresMessageRepository(database);
  const scope = { ownerId: "owner", agentId: "teammate" };
  const latest = await repository.page(scope);
  assert.equal(latest.messages.length, 100);
  assert.equal(latest.nextCursor, "message-106");
  assert.deepEqual(latest.messages[0], {
    id: "message-106",
    role: "user",
    text: "106",
    createdAt: "2026-10-12T00:00:00Z",
  });
  upperBound = 106;
  const middle = await repository.page(scope, latest.nextCursor!);
  upperBound = 6;
  const oldest = await repository.page(scope, middle.nextCursor!);
  assert.equal(oldest.nextCursor, null);
  assert.deepEqual(
    [...oldest.messages, ...middle.messages, ...latest.messages].map(
      (message) => message.text,
    ),
    records.map((record) => record.text),
  );
});

test("a foreign or missing cursor cannot read another teammate's history or broaden the query", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [MessageEntity],
  });
  const orm = database.getRepository(MessageEntity);
  context.mock.method(
    orm,
    "findOneBy",
    async (where: FindOptionsWhere<MessageRecord>) => {
      assert.deepEqual(where, {
        agentId: "own-teammate",
        agent: { ownerId: "owner" },
        id: "foreign-message",
      });
      return null;
    },
  );
  context.mock.method(orm, "find", async () =>
    assert.fail("Do not fall back to an unbounded history lookup"),
  );
  assert.deepEqual(
    await new PostgresMessageRepository(database).page(
      { ownerId: "owner", agentId: "own-teammate" },
      "foreign-message",
    ),
    { messages: [], nextCursor: null },
  );
});
