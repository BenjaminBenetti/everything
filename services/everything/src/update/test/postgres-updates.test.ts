import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { DataSource } from "typeorm";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import type { ConversationMessage } from "../../conversation/model/message.js";
import { PostgresMessageRepository } from "../../conversation/repository/postgres-message-repository.js";
import { MessageEntity } from "../../conversation/schema/message-entity.js";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { PostgresUpdateRepository } from "../repository/postgres-update-repository.js";
import { UpdateEntity } from "../schema/update-entity.js";
import { GeneralSettingsService } from "../../settings/service/general-settings-service.js";
import { PostgresGeneralSettingsRepository } from "../../settings/repository/postgres-general-settings-repository.js";
import { GeneralSettingsEntity } from "../../settings/schema/general-settings-entity.js";
import { UpdateService } from "../service/update-service.js";

/** An explicitly supplied test server; each run creates and removes only its own random database. */
const serverUrl = process.env.UPDATES_TEST_DATABASE_URL;

/** Schema statements TypeORM would run to match the entities; empty when migrations mirror them. */
async function drift(database: DataSource): Promise<string[]> {
  const log = await database.driver.createSchemaBuilder().log();
  return log.upQueries.map((query) => query.query);
}

test(
  "PostgreSQL migration, delivery, exact receipts, ownership, pagination, summaries, and cascades",
  { skip: !serverUrl },
  async () => {
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    const name = `updates_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const address = new URL(serverUrl!);
    address.pathname = `/${name}`;
    const settings = {
      databaseUrl: address.href,
      databasePassword: decodeURIComponent(address.password),
    };
    let database = createApplicationDatabase(settings);
    try {
      // Run the earlier schema and keep a delivered message to exercise an actual upgrade.
      database.setOptions({
        migrations: (database.options.migrations as Function[]).filter(
          (migration) =>
            !/^(Updates|UpdateHistory|GeneralSettings)/.test(migration.name),
        ),
      });
      await database.initialize();
      await database.runMigrations();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const siblingId = randomUUID();
      const inference = {
        provider: "openai-compatible",
        model: "summary-model",
        effort: "high",
      } as const;
      for (const [id, ownerId] of [
        [agentId, "owner"],
        [otherAgentId, "other"],
        [siblingId, "owner"],
      ] as const) {
        await database.getRepository(AgentEntity).save({
          id,
          ownerId,
          name: "Avery",
          systemPrompt: "Help",
          avatarId: "avatar-03",
          inference: id === agentId ? inference : null,
        });
      }
      await database.query(
        "INSERT INTO messages (id, agent_id, role, text) VALUES ($1, $2, 'assistant', 'Previously delivered')",
        [randomUUID(), agentId],
      );
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      await database.runMigrations();
      assert.deepEqual(
        await drift(database),
        [],
        "Migrations mirror the entities",
      );
      let messages = new PostgresMessageRepository(database);
      let updates = new PostgresUpdateRepository(database);
      let preferences = new GeneralSettingsService(
        new PostgresGeneralSettingsRepository(database),
      );
      assert.deepEqual(await preferences.read("owner"), {
        summarizeUpdates: false,
      });
      await preferences.update("owner", { summarizeUpdates: true });
      await preferences.update("other", { summarizeUpdates: true });
      let service = new UpdateService(updates, preferences);
      const updateRows = () => database.getRepository(UpdateEntity);
      const scope = { ownerId: "owner", agentId };
      const ownerScope = { ownerId: "owner" };

      // Earlier messages get no updates, and user input never creates one.
      assert.deepEqual(await service.list("owner"), {
        updates: [],
        nextCursor: null,
      });
      await messages.append(scope, "user", "User input stays out of updates");
      assert.deepEqual(await service.count("owner"), {
        unread: 0,
        byAgent: {},
      });
      assert.equal(await updateRows().count(), 0);

      // Each delivered reply commits exactly one update with it, or neither.
      const foreign = await messages.deliver(
        { ownerId: "other", agentId: otherAgentId },
        "Other owner's secret",
      );
      const sibling = await messages.deliver(
        { ownerId: "owner", agentId: siblingId },
        "Another conversation",
      );
      const delivered: ConversationMessage[] = [];
      for (let index = 0; index < 55; index++)
        delivered.push(
          await messages.deliver(
            scope,
            `**Result ${index}**   is ready.\nCan you review it?`,
          ),
        );
      assert.equal(await updateRows().count(), 57);
      for (const message of [foreign, sibling, ...delivered])
        assert.equal(await updateRows().countBy({ messageId: message.id }), 1);
      await database.query(
        "ALTER TABLE updates ADD CONSTRAINT updates_reject_test CHECK (false) NOT VALID",
      );
      await assert.rejects(messages.deliver(scope, "Never committed"));
      await database.query(
        "ALTER TABLE updates DROP CONSTRAINT updates_reject_test",
      );
      assert.equal(
        await database
          .getRepository(MessageEntity)
          .countBy({ text: "Never committed" }),
        0,
        "A failed update insert rolls back its message",
      );
      await assert.rejects(
        messages.deliver({ ownerId: "other", agentId }, "Wrong owner"),
        AgentNotFoundError,
      );
      assert.equal(await updateRows().count(), 57);

      // The feed is newest first, owner-scoped, side-effect free, and previews unsummarized sources.
      const first = await service.list("owner");
      assert.equal(first.updates.length, 50);
      const newest = first.updates[0]!;
      assert.equal(newest.kind, "message");
      assert.equal(newest.messageId, delivered.at(-1)!.id);
      assert.equal(newest.agentId, agentId);
      assert.equal(
        newest.summary,
        "**Result 54** is ready. Can you review it?",
      );
      assert.equal(newest.summaryStatus, "pending");
      assert.deepEqual(await service.list("owner"), first);
      assert.deepEqual(await service.count("owner"), {
        unread: 56,
        byAgent: { [agentId]: 55, [siblingId]: 1 },
      });
      assert.equal(
        first.updates.some((update) => update.messageId === foreign.id),
        false,
      );
      // A cursor can be read between pages without losing the rest of the backlog.
      const cursor = first.updates.at(-1)!;
      assert.equal(first.nextCursor, cursor.id);
      await service.read("owner", agentId, [cursor.messageId]);
      const second = await service.list("owner", first.nextCursor!);
      assert.equal(second.updates.length, 6);
      assert.equal(second.updates.at(-1)!.messageId, sibling.id);
      assert.equal(second.nextCursor, null);
      const foreignUpdate = await updateRows().findOneByOrFail({
        messageId: foreign.id,
      });
      assert.deepEqual(await service.list("owner", foreignUpdate.id), {
        updates: [],
        nextCursor: null,
      });

      // Receipts verify the teammate, change only its own unread message updates, and keep the first time.
      await assert.rejects(
        service.read("owner", otherAgentId, [foreign.id]),
        AgentNotFoundError,
      );
      await assert.rejects(
        service.read("owner", randomUUID(), [foreign.id]),
        AgentNotFoundError,
      );
      const selected = delivered.at(-1)!.id;
      await Promise.all([
        service.read("owner", agentId, [selected, foreign.id, sibling.id]),
        service.read("owner", agentId, [selected]),
        messages.deliver(scope, "Arrived during acknowledgement"),
      ]);
      const receipt = (
        await updateRows().findOneByOrFail({ messageId: selected })
      ).readAt;
      assert.ok(receipt);
      await service.read("owner", agentId, [selected]);
      assert.equal(
        (await updateRows().findOneByOrFail({ messageId: selected })).readAt,
        receipt,
      );
      for (const id of [foreign.id, sibling.id])
        assert.equal(
          (await updateRows().findOneByOrFail({ messageId: id })).readAt,
          null,
        );
      assert.deepEqual(await service.count("owner"), {
        unread: 55,
        byAgent: { [agentId]: 54, [siblingId]: 1 },
      });
      assert.deepEqual(await service.count("other"), {
        unread: 1,
        byAgent: { [otherAgentId]: 1 },
      });

      // Claims are owner-scoped, atomic, durable, and return the source and the teammate's model.
      const summaryUpdate = await updateRows().findOneByOrFail({
        messageId: delivered.at(-2)!.id,
      });
      assert.equal(
        await updates.claimSummary(ownerScope, foreignUpdate.id),
        undefined,
      );
      assert.equal(
        await updates.claimSummary({ ownerId: "other" }, summaryUpdate.id),
        undefined,
      );
      const readUpdate = await updateRows().findOneByOrFail({
        messageId: selected,
      });
      assert.equal(
        await updates.claimSummary(ownerScope, readUpdate.id),
        undefined,
        "Already read updates need no model call",
      );
      const claims = await Promise.all([
        updates.claimSummary(ownerScope, summaryUpdate.id),
        updates.claimSummary(ownerScope, summaryUpdate.id),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.deepEqual(
        { ...claims.find(Boolean)!, createdAt: undefined },
        {
          id: summaryUpdate.id,
          ownerId: "owner",
          createdAt: undefined,
          kind: "message",
          text: delivered.at(-2)!.text,
          inference,
        },
      );
      const generating = await updateRows().findOneByOrFail({
        id: summaryUpdate.id,
      });
      assert.equal(generating.summaryStatus, "generating");
      assert.ok(generating.summaryStartedAt);
      await updates.finishSummary(
        { ownerId: "other" },
        summaryUpdate.id,
        "Foreign write",
      );
      assert.equal(
        (await updateRows().findOneByOrFail({ id: summaryUpdate.id }))
          .summaryStatus,
        "generating",
      );
      await updates.finishSummary(
        ownerScope,
        summaryUpdate.id,
        "Needs your review of result 53.",
      );
      await updates.finishSummary(
        ownerScope,
        summaryUpdate.id,
        "A duplicate must not overwrite the summary.",
      );
      const failedId = (
        await updateRows().findOneByOrFail({ messageId: delivered.at(-3)!.id })
      ).id;
      await updates.claimSummary(ownerScope, failedId);
      await updates.finishSummary(ownerScope, failedId, null);
      const abandonedId = (
        await updateRows().findOneByOrFail({ messageId: delivered.at(-4)!.id })
      ).id;
      await updates.claimSummary(ownerScope, abandonedId);
      await updateRows().update(
        { id: abandonedId, ownerId: "owner" },
        { summaryStartedAt: new Date(Date.now() - 180_000).toISOString() },
      );
      const oversizedId = (
        await updateRows().findOneByOrFail({ messageId: delivered.at(-5)!.id })
      ).id;
      await updates.claimSummary(ownerScope, oversizedId);
      await assert.rejects(
        updates.finishSummary(ownerScope, oversizedId, "x".repeat(201)),
        "The database enforces the summary limit",
      );
      const due = await updates.pendingSummaries({
        createdBefore: new Date(Date.now() + 60_000),
      });
      assert.equal(
        due.some((target) =>
          [
            summaryUpdate.id,
            failedId,
            abandonedId,
            oversizedId,
            readUpdate.id,
          ].includes(target.id),
        ),
        false,
      );
      assert.ok(due.length > 0 && due.length <= 10);
      assert.ok(due.every((target) => target.ownerId && target.createdAt));
      assert.deepEqual(
        await updates.pendingSummaries({
          createdBefore: new Date(Date.now() - 3_600_000),
        }),
        [],
      );

      // Settings are owner-scoped and disabled backlogs never fill another owner's summary batch.
      assert.deepEqual(await preferences.read("owner"), {
        summarizeUpdates: true,
      });
      await preferences.update("owner", { summarizeUpdates: false });
      assert.deepEqual(await preferences.read("other"), {
        summarizeUpdates: true,
      });
      assert.deepEqual(
        (
          await updates.pendingSummaries({
            createdBefore: new Date(Date.now() + 60_000),
          })
        ).map((target) => target.id),
        [foreignUpdate.id],
      );
      const previews = await service.list("owner");
      assert.ok(
        previews.updates.every((update) => update.summaryStatus === "disabled"),
      );
      assert.equal(
        previews.updates.find((update) => update.id === summaryUpdate.id)!
          .summary,
        "**Result 53** is ready. Can you review it?",
      );
      await preferences.update("other", { summarizeUpdates: true });
      assert.equal(
        (
          await updates.pendingSummaries({
            createdBefore: new Date(Date.now() + 60_000),
          })
        ).length,
        1,
      );
      const settingsRepository = new PostgresGeneralSettingsRepository(
        database,
      );
      const [savedSettings] = await settingsRepository.list(ownerScope);
      assert.equal(
        await settingsRepository.getById(
          { ownerId: "other" },
          savedSettings!.id,
        ),
        undefined,
      );
      await settingsRepository.delete({ ownerId: "other" }, savedSettings!.id);
      assert.deepEqual(await preferences.read("owner"), {
        summarizeUpdates: false,
      });
      await assert.rejects(settingsRepository.list({ ownerId: "" }));
      assert.equal(
        await database.getRepository(GeneralSettingsEntity).count(),
        2,
      );

      // Recreate the connection and service to prove no process or browser-local state is required.
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      messages = new PostgresMessageRepository(database);
      updates = new PostgresUpdateRepository(database);
      preferences = new GeneralSettingsService(
        new PostgresGeneralSettingsRepository(database),
      );
      service = new UpdateService(updates, preferences);
      assert.deepEqual(await preferences.read("owner"), {
        summarizeUpdates: false,
      });
      assert.ok(
        (await service.list("owner")).updates.every(
          (update) => update.summaryStatus === "disabled",
        ),
      );
      await preferences.update("owner", { summarizeUpdates: true });
      const persisted = await service.list("owner");
      assert.equal(
        persisted.updates[0]!.summary,
        "Arrived during acknowledgement",
      );
      assert.equal(
        persisted.updates.some((update) => update.messageId === selected),
        false,
      );
      const byId = new Map(
        persisted.updates.map((update) => [update.id, update]),
      );
      assert.equal(
        byId.get(summaryUpdate.id)!.summary,
        "Needs your review of result 53.",
      );
      assert.equal(byId.get(summaryUpdate.id)!.summaryStatus, "ready");
      assert.equal(byId.get(failedId)!.summaryStatus, "unavailable");
      assert.equal(byId.get(abandonedId)!.summaryStatus, "unavailable");
      assert.equal(byId.get(oversizedId)!.summaryStatus, "pending");
      for (const id of [summaryUpdate.id, failedId, abandonedId])
        assert.equal(await updates.claimSummary(ownerScope, id), undefined);
      const history = await messages.page(scope);
      assert.ok(history.messages.some((message) => message.id === selected));
      assert.deepEqual(Object.keys(history.messages[0]!).sort(), [
        "createdAt",
        "id",
        "role",
        "text",
      ]);

      // Seen history survives reconnects, remains scoped, and pages by original delivery order.
      const initiallySeen = await service.seen("owner");
      assert.ok(
        initiallySeen.updates.some((update) => update.messageId === selected),
      );
      assert.ok(
        initiallySeen.updates.every(
          (update) => update.summaryStatus !== "pending",
        ),
      );
      await updates.readMessages(
        scope,
        delivered.map((message) => message.id),
      );
      const seenFirst = await service.seen("owner");
      assert.equal(seenFirst.updates.length, 50);
      assert.ok(seenFirst.nextCursor);
      const seenNext = await service.seen("owner", seenFirst.nextCursor!);
      const seenIds = [...seenFirst.updates, ...seenNext.updates].map(
        (update) => update.messageId,
      );
      assert.equal(new Set(seenIds).size, seenIds.length);
      assert.ok(delivered.every((message) => seenIds.includes(message.id)));
      assert.ok(!seenIds.includes(foreign.id));
      assert.ok(!seenIds.includes(sibling.id));
      assert.equal(seenNext.nextCursor, null);
      assert.deepEqual(await service.seen("owner", foreignUpdate.id), {
        updates: [],
        nextCursor: null,
      });
      assert.deepEqual(await service.seen("other"), {
        updates: [],
        nextCursor: null,
      });
      const recentSeen = await messages.deliver(scope, "Newest seen result");
      await updates.readMessages(scope, [recentSeen.id]);
      assert.deepEqual(
        await service.seen("owner", seenFirst.nextCursor!),
        seenNext,
      );
      assert.equal(
        (await service.seen("owner")).updates[0]!.messageId,
        recentSeen.id,
      );

      // Each kind's references are enforced, and deleting a source removes its updates.
      await assert.rejects(
        database.getRepository(UpdateEntity).insert({
          id: randomUUID(),
          ownerId: "owner",
          kind: "message",
          agentId,
        }),
      );
      await assert.rejects(
        database.getRepository(UpdateEntity).insert({
          id: randomUUID(),
          ownerId: "owner",
          kind: "unknown" as "message",
        }),
      );
      await database
        .getRepository(AgentEntity)
        .delete({ id: agentId, ownerId: "owner" });
      assert.deepEqual(
        (await service.list("owner")).updates.map((update) => update.messageId),
        [sibling.id],
      );
      assert.deepEqual(await service.count("owner"), {
        unread: 1,
        byAgent: { [siblingId]: 1 },
      });
      await messages.delete(
        { ownerId: "owner", agentId: siblingId },
        sibling.id,
      );
      assert.deepEqual(await service.count("owner"), {
        unread: 0,
        byAgent: {},
      });

      // The migration can be reverted and reapplied without drift.
      await database.undoLastMigration();
      await database.undoLastMigration();
      await database.undoLastMigration();
      await database.undoLastMigration();
      await database.undoLastMigration();
      const runner = database.createQueryRunner();
      assert.equal(await runner.hasTable("updates"), false);
      await runner.release();
      await database.runMigrations();
      assert.deepEqual(await drift(database), []);
    } finally {
      if (database.isInitialized) await database.destroy();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
