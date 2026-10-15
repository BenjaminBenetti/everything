import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DataSource,
  IsNull,
  LessThan,
  Not,
  type FindManyOptions,
  type FindOneOptions,
} from "typeorm";
import { updatePageSize } from "@everything/update-contracts";
import type { MessageRecord } from "../../conversation/model/message-record.js";
import type { UpdateRecord } from "../model/update-record.js";
import { PostgresUpdateRepository } from "../repository/postgres-update-repository.js";
import { UpdateEntity } from "../schema/update-entity.js";

/** A message update record with its eagerly loaded source message. */
function record(index: number): UpdateRecord {
  return {
    id: `update-${index}`,
    ownerId: "owner",
    createdAt: "2026-10-15T00:00:00.000Z",
    kind: "message",
    sequence: String(index),
    agentId: "teammate",
    messageId: `message-${index}`,
    message: {
      id: `message-${index}`,
      agentId: "teammate",
      role: "assistant",
      text: `Reply ${index}`,
      sequence: String(index),
      createdAt: "2026-10-15T00:00:00.000Z",
    } satisfies MessageRecord,
    summary: null,
    summaryStatus: "pending",
    summaryStartedAt: null,
    readAt: null,
  };
}

/** Build the repository over an uninitialized data source whose ORM calls the test replaces. */
function fixture() {
  const database = new DataSource({
    type: "postgres",
    entities: [UpdateEntity],
  });
  return {
    orm: database.getRepository(UpdateEntity),
    repository: new PostgresUpdateRepository(database),
  };
}

test("feed pages are owner-scoped, newest first, and bounded by the cursor's position even after it is read", async (context) => {
  const f = fixture();
  const records = Array.from({ length: 60 }, (_, index) => record(index + 1));
  context.mock.method(
    f.orm,
    "findOne",
    async (options: FindOneOptions<UpdateRecord>) => {
      assert.deepEqual(options, {
        where: { ownerId: "owner", id: "update-55" },
        loadEagerRelations: false,
      });
      return { ...records[54]!, readAt: "2026-10-15T00:01:00.000Z" };
    },
  );
  const queries: FindManyOptions<UpdateRecord>[] = [];
  context.mock.method(
    f.orm,
    "find",
    async (options: FindManyOptions<UpdateRecord>) => {
      queries.push(options);
      const bound = (options.where as { sequence?: unknown }).sequence
        ? 55
        : 61;
      return records
        .filter((item) => Number(item.sequence) < bound)
        .reverse()
        .slice(0, options.take);
    },
  );
  const first = await f.repository.unread({ ownerId: "owner" });
  assert.equal(first.updates.length, updatePageSize);
  assert.equal(first.updates[0]!.id, "update-60");
  assert.equal(first.updates[0]!.sourceText, "Reply 60");
  assert.equal(first.nextCursor, "update-11");
  const next = await f.repository.unread({ ownerId: "owner" }, "update-55");
  assert.equal(next.updates[0]!.id, "update-54");
  assert.deepEqual(queries, [
    {
      where: { ownerId: "owner", readAt: IsNull() },
      order: { sequence: "DESC" },
      take: updatePageSize + 1,
    },
    {
      where: {
        ownerId: "owner",
        readAt: IsNull(),
        sequence: LessThan("55"),
      },
      order: { sequence: "DESC" },
      take: updatePageSize + 1,
    },
  ]);
});

test("a foreign or missing cursor returns nothing rather than broadening the query", async (context) => {
  const f = fixture();
  context.mock.method(f.orm, "findOne", async () => null);
  context.mock.method(f.orm, "find", async () =>
    assert.fail("Do not fall back to an unbounded feed lookup"),
  );
  assert.deepEqual(
    await f.repository.unread({ ownerId: "owner" }, "foreign-update"),
    { updates: [], nextCursor: null },
  );
  assert.deepEqual(
    await f.repository.seen({ ownerId: "owner" }, "foreign-update"),
    { updates: [], nextCursor: null },
  );
});

test("seen history filters read updates by owner and original sequence", async (context) => {
  const f = fixture();
  context.mock.method(
    f.orm,
    "findOne",
    async (options: FindOneOptions<UpdateRecord>) => {
      assert.deepEqual(options.where, { ownerId: "owner", id: "update-55" });
      return record(55);
    },
  );
  context.mock.method(
    f.orm,
    "find",
    async (options: FindManyOptions<UpdateRecord>) => {
      assert.deepEqual(options, {
        where: {
          ownerId: "owner",
          readAt: Not(IsNull()),
          sequence: LessThan("55"),
        },
        order: { sequence: "DESC" },
        take: updatePageSize + 1,
      });
      return [{ ...record(54), readAt: "2026-10-15T00:01:00.000Z" }];
    },
  );
  const page = await f.repository.seen({ ownerId: "owner" }, "update-55");
  assert.equal(page.updates[0]!.sourceText, "Reply 54");
  assert.equal(page.nextCursor, null);
});

test("unread totals include every page, group teammate references, and refuse an omitted owner", async (context) => {
  const f = fixture();
  const records = [
    ...Array.from({ length: updatePageSize + 5 }, () => ({ agentId: "avery" })),
    { agentId: "blake" },
    { agentId: "blake" },
    { agentId: null },
  ];
  context.mock.method(
    f.orm,
    "find",
    async (options: FindManyOptions<UpdateRecord>) => {
      assert.deepEqual(options, {
        select: { id: true, agentId: true },
        where: { ownerId: "owner", readAt: IsNull() },
        loadEagerRelations: false,
      });
      return records;
    },
  );
  assert.deepEqual(await f.repository.countUnread({ ownerId: "owner" }), {
    unread: updatePageSize + 8,
    byAgent: { avery: updatePageSize + 5, blake: 2 },
  });
  records.length = 0;
  assert.deepEqual(await f.repository.countUnread({ ownerId: "owner" }), {
    unread: 0,
    byAgent: {},
  });
  await assert.rejects(f.repository.countUnread({ ownerId: "" }), /owner/);
  await assert.rejects(f.repository.unread({ ownerId: "" }), /owner/);
});
