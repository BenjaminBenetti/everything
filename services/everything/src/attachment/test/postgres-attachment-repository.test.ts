import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  DataSource,
  IsNull,
  LessThan,
  Not,
  type EntityManager,
  type FindManyOptions,
  type FindOneOptions,
  type FindOptionsWhere,
} from "typeorm";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { MessageEntity } from "../../conversation/schema/message-entity.js";
import { PostgresMessageRepository } from "../../conversation/repository/postgres-message-repository.js";
import {
  AttachmentInUseError,
  AttachmentUnavailableError,
} from "../error/attachment-errors.js";
import type { AttachmentRecord } from "../model/attachment.js";
import { PostgresAttachmentRepository } from "../repository/postgres-attachment-repository.js";
import { AttachmentEntity } from "../schema/attachment-entity.js";

const scope = { ownerId: "owner", agentId: "teammate" };

/** A complete, unsent attachment record. */
function record(
  id: string,
  changes: Partial<AttachmentRecord> = {},
): AttachmentRecord {
  return {
    id,
    agentId: "teammate",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    name: `${id}.txt`,
    size: 3,
    received: 3,
    status: "ready",
    kind: "text",
    mediaType: "text/plain",
    path: `/workspace/teammate/attachments/${id}/${id}.txt`,
    messageId: null,
    position: null,
    ...changes,
  };
}

/** Run serializable transactions against fake repositories keyed by entity. */
function transactions(
  context: TestContext,
  manager: EntityManager,
  repositories: Map<unknown, object>,
) {
  context.mock.method(
    manager,
    "transaction",
    async (
      _isolation: string,
      operation: (manager: EntityManager) => unknown,
    ) =>
      operation({
        getRepository: (target: unknown) =>
          repositories.get(target) ??
          assert.fail(`Unexpected repository ${String(target)}`),
      } as unknown as EntityManager),
  );
}

test("owner lookups follow the teammate relation, and maintenance must name its scope", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [AttachmentEntity],
  });
  const orm = database.getRepository(AttachmentEntity);
  const repository = new PostgresAttachmentRepository(database);
  const lookups: FindOptionsWhere<AttachmentRecord>[] = [];
  context.mock.method(
    orm,
    "findOneBy",
    async (where: FindOptionsWhere<AttachmentRecord>) => {
      lookups.push(where);
      return null;
    },
  );
  assert.equal(await repository.getById(scope, "forged"), undefined);
  assert.equal(
    await repository.getById({ ownership: "all" }, "forged"),
    undefined,
  );
  assert.deepEqual(lookups, [
    { agentId: "teammate", agent: { ownerId: "owner" }, id: "forged" },
    { agentId: Not(IsNull()), id: "forged" },
  ]);
  await assert.rejects(
    repository.getById({ ownership: "some" } as never, "forged"),
    /explicit ownership scope/,
  );
  const listed: FindManyOptions<AttachmentRecord>[] = [];
  context.mock.method(
    orm,
    "find",
    async (options: FindManyOptions<AttachmentRecord>) => {
      listed.push(options);
      return [record("a"), record("b", { status: "uploading", kind: null })];
    },
  );
  const unsent = await repository.unsent(scope);
  assert.deepEqual(
    unsent.map((item) => [item.id, "agentId" in item]),
    [
      ["a", false],
      ["b", false],
    ],
  );
  const expiry = {
    uploadingBefore: "2026-10-30T11:45:00.000Z",
    readyBefore: "2026-10-29T12:00:00.000Z",
  };
  const expired = await repository.expired({ ownership: "all" }, expiry);
  assert.equal(expired[0]!.agentId, "teammate");
  assert.deepEqual(listed, [
    {
      where: {
        agentId: "teammate",
        agent: { ownerId: "owner" },
        messageId: IsNull(),
      },
      order: { createdAt: "ASC", id: "ASC" },
    },
    {
      where: [
        {
          agentId: Not(IsNull()),
          messageId: IsNull(),
          status: "uploading",
          updatedAt: LessThan(expiry.uploadingBefore),
        },
        {
          agentId: Not(IsNull()),
          messageId: IsNull(),
          status: "ready",
          updatedAt: LessThan(expiry.readyBefore),
        },
      ],
      order: { updatedAt: "ASC", id: "ASC" },
      take: 100,
    },
  ]);
});

test("uploads are created only for the owner's teammate and removed only while unsent", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [AttachmentEntity, AgentEntity],
  });
  const repository = new PostgresAttachmentRepository(database);
  let agent: object | null = null;
  const removed: string[] = [];
  const saved: Partial<AttachmentRecord>[] = [];
  let stored: AttachmentRecord | null = record("sent", {
    messageId: "message",
  });
  transactions(
    context,
    database.getRepository(AttachmentEntity).manager,
    new Map<unknown, object>([
      [
        AgentEntity,
        {
          findOne: async (options: FindOneOptions) => {
            assert.deepEqual(options.where, {
              id: "teammate",
              ownerId: "owner",
            });
            return agent;
          },
        },
      ],
      [
        AttachmentEntity,
        {
          create: (value: Partial<AttachmentRecord>) => value,
          save: async (value: Partial<AttachmentRecord>) => {
            saved.push(value);
            return { ...value, createdAt: "2026-10-30T00:00:00.000Z" };
          },
          findOneBy: async (where: FindOptionsWhere<AttachmentRecord>) => {
            assert.deepEqual(where, {
              agentId: "teammate",
              agent: { ownerId: "owner" },
              id: where.id,
            });
            return stored;
          },
          remove: async (value: AttachmentRecord) => {
            removed.push(value.id);
          },
        },
      ],
    ]),
  );
  const upload = {
    id: "new",
    name: "notes.txt",
    size: 3,
    path: "/workspace/teammate/attachments/new/notes.txt",
  };
  await assert.rejects(repository.create(scope, upload), AgentNotFoundError);
  agent = { id: "teammate", ownerId: "owner" };
  const created = await repository.create(scope, upload);
  assert.equal(created.status, "uploading");
  assert.equal(saved[0]!.agentId, "teammate");
  assert.equal(saved[0]!.messageId, null);
  await assert.rejects(
    repository.removeUnsent(scope, "sent"),
    AttachmentInUseError,
  );
  assert.deepEqual(removed, []);
  stored = record("draft");
  assert.equal((await repository.removeUnsent(scope, "draft"))?.id, "draft");
  assert.deepEqual(removed, ["draft"]);
  stored = null;
  assert.equal(await repository.removeUnsent(scope, "forged"), undefined);
});

test("saving a message claims each named attachment of the same teammate, in order, or none at all", async (context) => {
  const database = new DataSource({
    type: "postgres",
    entities: [MessageEntity, AgentEntity, AttachmentEntity],
  });
  const messages = new PostgresMessageRepository(database);
  const available = new Map([
    ["first", record("first", { kind: "image", mediaType: "image/png" })],
    ["second", record("second")],
  ]);
  const claimed: [string, unknown][] = [];
  transactions(
    context,
    database.getRepository(MessageEntity).manager,
    new Map<unknown, object>([
      [
        AgentEntity,
        {
          findOne: async () => ({ id: "teammate", ownerId: "owner" }),
          update: async () => undefined,
        },
      ],
      [
        MessageEntity,
        {
          create: (value: object) => value,
          save: async (value: object) => ({
            ...value,
            sequence: "1",
            createdAt: "2026-10-30T00:00:00.000Z",
          }),
        },
      ],
      [
        AttachmentEntity,
        {
          findOne: async (options: FindOneOptions<AttachmentRecord>) => {
            const where = options.where as FindOptionsWhere<AttachmentRecord>;
            assert.deepEqual(options.lock, { mode: "pessimistic_write" });
            assert.deepEqual(
              { ...where, id: undefined },
              {
                id: undefined,
                agentId: "teammate",
                status: "ready",
                messageId: IsNull(),
              },
            );
            return available.get(where.id as string) ?? null;
          },
          update: async (where: { id: string }, changes: unknown) => {
            claimed.push([where.id, changes]);
          },
        },
      ],
    ]),
  );
  const message = await messages.append(scope, "user", "", ["second", "first"]);
  assert.equal(message.text, "");
  assert.deepEqual(
    message.attachments.map((item) => [item.id, item.kind]),
    [
      ["second", "text"],
      ["first", "image"],
    ],
  );
  assert.deepEqual(
    claimed.map(([id, changes]) => [
      id,
      (changes as { position: number }).position,
    ]),
    [
      ["second", 0],
      ["first", 1],
    ],
  );
  await assert.rejects(
    messages.append(scope, "user", "look", ["first", "forged"]),
    AttachmentUnavailableError,
  );
});
