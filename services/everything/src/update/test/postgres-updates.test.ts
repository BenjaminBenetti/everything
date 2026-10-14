import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { ConversationMessage } from "../../conversation/model/message.js";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { AgentEntity } from "../../agent/schema/agent-entity.js";
import { MessageEntity } from "../../conversation/schema/message-entity.js";
import { PostgresMessageRepository } from "../../conversation/repository/postgres-message-repository.js";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { UpdateService } from "../service/update-service.js";

/** An explicitly supplied test server; each run creates and removes only its own random database. */
const serverUrl = process.env.UPDATES_TEST_DATABASE_URL;

test(
  "PostgreSQL migration, exact receipts, ownership, pagination, concurrency, and reconnect persistence",
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
      // First run the old schema and retain a message to exercise an actual upgrade.
      database.setOptions({
        migrations: (database.options.migrations as Function[]).slice(0, -1),
      });
      await database.initialize();
      await database.runMigrations();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const siblingId = randomUUID();
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
          inference: null,
        });
      }
      const historicalId = randomUUID();
      await database.query(
        "INSERT INTO messages (id, agent_id, role, text) VALUES ($1, $2, 'assistant', 'Previously delivered')",
        [historicalId, agentId],
      );
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      await database.runMigrations();
      let repository = new PostgresMessageRepository(database);
      let service = new UpdateService(repository);
      const scope = { ownerId: "owner", agentId };
      assert.deepEqual(await service.list("owner"), {
        updates: [],
        nextCursor: null,
      });
      assert.ok(
        (
          await database
            .getRepository(MessageEntity)
            .findOneByOrFail({ id: historicalId })
        ).readAt,
      );
      await repository.append(scope, "user", "User input stays out of updates");
      const foreign = await repository.append(
        { ownerId: "other", agentId: otherAgentId },
        "assistant",
        "Other owner's secret",
      );
      const sibling = await repository.append(
        { ownerId: "owner", agentId: siblingId },
        "assistant",
        "Another conversation",
      );
      const messages: ConversationMessage[] = [];
      for (let index = 0; index < 55; index++)
        messages.push(
          await repository.append(
            scope,
            "assistant",
            `**Result ${index}** is ready. Can you review it?`,
          ),
        );
      const first = await service.list("owner");
      assert.equal(first.updates.length, 50);
      assert.equal(first.updates[0]!.messageId, messages.at(-1)!.id);
      assert.equal(
        first.updates[0]!.summary,
        "**Result 54** is ready. Can you review it?",
      );
      assert.deepEqual(
        await service.list("owner"),
        first,
        "Repeated fetches neither duplicate nor acknowledge updates",
      );
      assert.equal(
        first.updates.some((update) => update.messageId === foreign.id),
        false,
      );
      // A cursor can be read between pages without losing the rest of the backlog.
      await service.read("owner", agentId, [first.nextCursor!]);
      const second = await service.list("owner", first.nextCursor!);
      assert.equal(second.updates.length, 6);
      assert.equal(second.nextCursor, null);
      assert.deepEqual(await service.list("owner", foreign.id), {
        updates: [],
        nextCursor: null,
      });
      await assert.rejects(
        service.read("owner", otherAgentId, [foreign.id]),
        AgentNotFoundError,
      );
      await assert.rejects(
        service.read("owner", randomUUID(), [foreign.id]),
        AgentNotFoundError,
      );
      const selected = messages.at(-1)!.id;
      await Promise.all([
        service.read("owner", agentId, [selected, foreign.id, sibling.id]),
        service.read("owner", agentId, [selected]),
        repository.append(scope, "assistant", "Arrived during acknowledgement"),
      ]);
      const receipt = (
        await database
          .getRepository(MessageEntity)
          .findOneByOrFail({ id: selected })
      ).readAt;
      await service.read("owner", agentId, [selected]);
      assert.equal(
        (
          await database
            .getRepository(MessageEntity)
            .findOneByOrFail({ id: selected })
        ).readAt,
        receipt,
      );
      assert.equal(
        (
          await database
            .getRepository(MessageEntity)
            .findOneByOrFail({ id: foreign.id })
        ).readAt,
        null,
      );
      assert.equal(
        (
          await database
            .getRepository(MessageEntity)
            .findOneByOrFail({ id: sibling.id })
        ).readAt,
        null,
      );
      // Claims are owner-scoped, atomic, durable, and do not infer from feed reads.
      assert.equal(await repository.claimSummary(scope, foreign.id), undefined);
      assert.equal(
        await repository.claimSummary(
          { ownerId: "other", agentId },
          messages.at(-2)!.id,
        ),
        undefined,
      );
      assert.equal(
        await repository.claimSummary(scope, selected),
        undefined,
        "Already read replies need no model call",
      );
      const summaryId = messages.at(-2)!.id;
      const claims = await Promise.all([
        repository.claimSummary(scope, summaryId),
        repository.claimSummary(scope, summaryId),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(claims.find(Boolean)!.ownerId, "owner");
      assert.equal(claims.find(Boolean)!.text, messages.at(-2)!.text);
      await repository.finishSummary(
        { ownerId: "other", agentId },
        summaryId,
        "Foreign write",
      );
      assert.equal(
        (
          await database
            .getRepository(MessageEntity)
            .findOneByOrFail({ id: summaryId })
        ).summaryStatus,
        "generating",
      );
      await repository.finishSummary(
        scope,
        summaryId,
        "The result is ready for review.",
      );
      await repository.finishSummary(
        scope,
        summaryId,
        "A duplicate must not overwrite the summary.",
      );
      const failedId = messages.at(-3)!.id;
      await repository.claimSummary(scope, failedId);
      await repository.finishSummary(scope, failedId, null);
      const abandonedId = messages.at(-4)!.id;
      await repository.claimSummary(scope, abandonedId);
      await database
        .getRepository(MessageEntity)
        .update(
          { id: abandonedId, agentId },
          { summaryStartedAt: new Date(Date.now() - 180_000).toISOString() },
        );
      const due = await repository.pendingSummaries({
        createdBefore: new Date(Date.now() + 60_000),
      });
      assert.equal(
        due.some((target) =>
          [summaryId, failedId, abandonedId, selected].includes(target.id),
        ),
        false,
      );
      assert.ok(due.every((target) => target.ownerId && target.agentId));
      // Recreate the connection and service to prove no process or browser-local state is required.
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      repository = new PostgresMessageRepository(database);
      service = new UpdateService(repository);
      const persisted = await service.list("owner");
      assert.equal(
        persisted.updates[0]!.summary,
        "Arrived during acknowledgement",
      );
      assert.equal(
        persisted.updates.some((update) => update.messageId === selected),
        false,
      );
      assert.ok(
        persisted.updates.some(
          (update) => update.messageId === messages.at(-2)!.id,
        ),
        "Unseen gaps remain unread",
      );
      const generated = persisted.updates.find(
        (update) => update.messageId === summaryId,
      )!;
      assert.equal(generated.summary, "The result is ready for review.");
      assert.equal(generated.summaryStatus, "ready");
      assert.equal(
        persisted.updates.find((update) => update.messageId === failedId)!
          .summaryStatus,
        "unavailable",
      );
      assert.equal(
        persisted.updates.find((update) => update.messageId === abandonedId)!
          .summaryStatus,
        "unavailable",
      );
      for (const id of [summaryId, failedId, abandonedId])
        assert.equal(await repository.claimSummary(scope, id), undefined);
      const history = await repository.page(scope);
      assert.ok(history.messages.some((message) => message.id === selected));
      assert.equal("readAt" in history.messages[0]!, false);
      assert.equal("updateSummary" in history.messages[0]!, false);
      await database
        .getRepository(AgentEntity)
        .delete({ id: agentId, ownerId: "owner" });
      assert.deepEqual(
        (await service.list("owner")).updates.map((update) => update.messageId),
        [sibling.id],
      );
    } finally {
      if (database.isInitialized) await database.destroy();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
