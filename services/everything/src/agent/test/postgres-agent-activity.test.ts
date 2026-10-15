import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { PostgresMessageRepository } from "../../conversation/repository/postgres-message-repository.js";
import { AgentNotFoundError } from "../error/agent-errors.js";
import { PostgresAgentActivityRepository } from "../repository/postgres-agent-activity-repository.js";
import { PostgresAgentRepository } from "../repository/postgres-agent-repository.js";
import {
  AgentActivityService,
  recentAgentListing,
} from "../service/agent-activity-service.js";

/** An explicit disposable test server; each run owns and removes only its random database. */
const serverUrl = process.env.AGENT_ACTIVITY_TEST_DATABASE_URL;

test(
  "recent teammates backfill user messages, stay scoped and distinct, and survive reconnecting",
  { skip: !serverUrl },
  async () => {
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    const name = `agent_activity_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const address = new URL(serverUrl!);
    address.pathname = `/${name}`;
    const settings = {
      databaseUrl: address.href,
      databasePassword: decodeURIComponent(address.password),
    };
    let database = createApplicationDatabase(settings);
    try {
      database.setOptions({
        migrations: (database.options.migrations as Function[]).filter(
          (migration) => migration.name !== "AgentInteractions1792540800000",
        ),
      });
      await database.initialize();
      await database.runMigrations();
      const ids = Array.from({ length: 6 }, () => randomUUID());
      for (const [index, id] of ids.entries()) {
        await database.query(
          "INSERT INTO agents (id, owner_id, name, system_prompt) VALUES ($1, $2, $3, 'Help')",
          [id, index === 5 ? "other" : "owner", `Teammate ${index}`],
        );
        if (index !== 4)
          await database.query(
            "INSERT INTO messages (id, agent_id, role, text, created_at) VALUES ($1, $2, 'user', 'Hello', $3)",
            [randomUUID(), id, `2026-10-0${index + 1}T10:00:00Z`],
          );
        await database.query(
          "INSERT INTO messages (id, agent_id, role, text, created_at) VALUES ($1, $2, 'assistant', 'Background reply', '2026-10-10T10:00:00Z')",
          [randomUUID(), id],
        );
      }
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      await database.runMigrations();
      assert.deepEqual(
        (await database.driver.createSchemaBuilder().log()).upQueries,
        [],
        "The migration matches the mapped schema",
      );
      let store = new PostgresAgentActivityRepository(
        database,
        recentAgentListing,
      );
      let activity = new AgentActivityService(store);
      assert.deepEqual(
        (await activity.recent("owner")).map((agent) => agent.id),
        [ids[3], ids[2], ids[1]],
      );
      assert.deepEqual(
        (await activity.recent("other")).map((agent) => agent.id),
        [ids[5]],
      );
      assert.deepEqual(await activity.recent("new-owner"), []);
      const visitedAt = new Date(Date.now() - 1_000).toISOString();
      await store.touch({ ownerId: "owner" }, ids[0]!, visitedAt);
      await store.touch({ ownerId: "owner" }, ids[0]!, "2026-10-01T00:00:00Z");
      assert.deepEqual(
        (await activity.recent("owner")).map((agent) => agent.id),
        [ids[0], ids[3], ids[2]],
      );
      assert.equal(
        (await store.getById({ ownerId: "owner" }, ids[0]!))!.lastInteractedAt,
        visitedAt,
      );
      for (const id of [ids[5]!, randomUUID()])
        await assert.rejects(activity.touch("owner", id), AgentNotFoundError);
      await assert.rejects(activity.recent(""));
      await assert.rejects(activity.touch("", ids[0]!));
      const messages = new PostgresMessageRepository(database);
      await messages.append(
        { ownerId: "owner", agentId: ids[1]! },
        "user",
        "Pick this up again",
      );
      const expected = [ids[1], ids[0], ids[3]];
      assert.deepEqual(
        (await activity.recent("owner")).map((agent) => agent.id),
        expected,
      );
      await messages.deliver(
        { ownerId: "owner", agentId: ids[2]! },
        "An unsolicited reply",
      );
      await messages.page({ ownerId: "owner", agentId: ids[2]! });
      assert.deepEqual(
        (await activity.recent("owner")).map((agent) => agent.id),
        expected,
      );
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      store = new PostgresAgentActivityRepository(database, recentAgentListing);
      activity = new AgentActivityService(store);
      assert.deepEqual(
        (await activity.recent("owner")).map((agent) => agent.id),
        expected,
      );
      await new PostgresAgentRepository(database).delete(
        { ownerId: "owner" },
        ids[1]!,
      );
      assert.deepEqual(
        (await activity.recent("owner")).map((agent) => agent.id),
        [ids[0], ids[3], ids[2]],
      );
      await database.undoLastMigration();
      await database.runMigrations();
      assert.deepEqual(
        (await database.driver.createSchemaBuilder().log()).upQueries,
        [],
      );
    } finally {
      if (database.isInitialized) await database.destroy();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
