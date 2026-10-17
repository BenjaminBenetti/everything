import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { PostgresGeneralSettingsRepository } from "../repository/postgres-general-settings-repository.js";
import { GeneralSettingsService } from "../service/general-settings-service.js";
import { TeammateOrderService } from "../service/teammate-order-service.js";

/** An explicit disposable test server; each run owns and removes only its random database. */
const serverUrl = process.env.GENERAL_SETTINGS_TEST_DATABASE_URL;

test(
  "teammate order migrates existing preferences, merges with summaries, stays scoped, and survives reconnecting",
  { skip: !serverUrl },
  async () => {
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    const name = `general_settings_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const address = new URL(serverUrl!);
    address.pathname = `/${name}`;
    const settings = {
      databaseUrl: address.href,
      databasePassword: decodeURIComponent(address.password),
    };
    let database = createApplicationDatabase(settings);
    try {
      // Save summaries under the earlier schema to exercise an actual upgrade.
      database.setOptions({
        migrations: (database.options.migrations as Function[]).filter(
          (migration) =>
            migration.name !== "GeneralSettingsTeammateOrder1792800000000",
        ),
      });
      await database.initialize();
      await database.runMigrations();
      const existingId = randomUUID();
      await database.query(
        "INSERT INTO general_settings (id, owner_id, summarize_updates) VALUES ($1, 'owner', true)",
        [existingId],
      );
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      await database.runMigrations();
      assert.deepEqual(
        (await database.driver.createSchemaBuilder().log()).upQueries,
        [],
        "The migration matches the mapped schema",
      );
      let repository = new PostgresGeneralSettingsRepository(database);
      let order = new TeammateOrderService(repository);
      let general = new GeneralSettingsService(repository);
      assert.deepEqual(await order.read("owner"), { teammateIds: [] });
      assert.deepEqual(await general.read("owner"), { summarizeUpdates: true });

      // Each preference saves without overwriting the other or the record's identity.
      const teammateIds = [randomUUID(), randomUUID(), randomUUID()];
      assert.deepEqual(await order.update("owner", { teammateIds }), {
        teammateIds,
      });
      assert.deepEqual(await general.read("owner"), { summarizeUpdates: true });
      await general.update("owner", { summarizeUpdates: false });
      assert.deepEqual(await order.read("owner"), { teammateIds });
      const [record] = await repository.list({ ownerId: "owner" });
      assert.equal(record!.id, existingId);

      // An owner's first save creates one record with defaults for everything else.
      const firstOrder = [randomUUID()];
      await order.update("newcomer", { teammateIds: firstOrder });
      assert.deepEqual(await general.read("newcomer"), {
        summarizeUpdates: false,
      });
      await Promise.all([
        general.update("newcomer", { summarizeUpdates: true }),
        order.update("newcomer", {
          teammateIds: [...firstOrder, randomUUID()],
        }),
      ]);
      assert.deepEqual(await general.read("newcomer"), {
        summarizeUpdates: true,
      });
      assert.equal((await order.read("newcomer")).teammateIds.length, 2);
      assert.equal(
        (await repository.list({ ownerId: "newcomer" })).length,
        1,
        "Concurrent saves share one record",
      );

      // Ownership applies to every read and removal.
      assert.equal(
        await repository.getById({ ownerId: "newcomer" }, existingId),
        undefined,
      );
      await repository.delete({ ownerId: "newcomer" }, existingId);
      assert.deepEqual(await order.read("owner"), { teammateIds });
      assert.deepEqual(await order.read("stranger"), { teammateIds: [] });
      await assert.rejects(repository.list({ ownerId: "" }));

      // Recreate the connection to prove the order needs no process or browser state.
      await database.destroy();
      database = createApplicationDatabase(settings);
      await database.initialize();
      repository = new PostgresGeneralSettingsRepository(database);
      order = new TeammateOrderService(repository);
      general = new GeneralSettingsService(repository);
      assert.deepEqual(await order.read("owner"), { teammateIds });
      assert.deepEqual(await general.read("owner"), {
        summarizeUpdates: false,
      });
      await database.undoLastMigration();
      await database.runMigrations();
      assert.deepEqual(
        (await database.driver.createSchemaBuilder().log()).upQueries,
        [],
      );
      assert.deepEqual(await order.read("owner"), { teammateIds: [] });
      assert.deepEqual(await general.read("owner"), {
        summarizeUpdates: false,
      });
    } finally {
      if (database.isInitialized) await database.destroy();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
