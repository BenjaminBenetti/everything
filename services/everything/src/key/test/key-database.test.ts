import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { DataSource } from "typeorm";
import { createApplicationDatabase } from "../../persistence/factory/application-database.js";
import { GenericCredentials1792886400000 } from "../../persistence/migration/1792886400000-generic-credentials.js";
import { PostgresGenericCredentialRepository } from "../repository/postgres-generic-credential-repository.js";
import { PostgresKeyRepository } from "../repository/postgres-key-repository.js";
import { PostgresSshKeyRepository } from "../repository/postgres-ssh-key-repository.js";
import type { StoredKey } from "../model/stored-key.js";

// Runs against a real, disposable PostgreSQL server when EVERYTHING_TEST_DATABASE_URL names one,
// for example postgresql://postgres@127.0.0.1:55432/postgres with EVERYTHING_TEST_DATABASE_PASSWORD.
// Each test creates and drops its own database. Without the variable these tests are skipped.
const adminUrl = process.env.EVERYTHING_TEST_DATABASE_URL;
const password = process.env.EVERYTHING_TEST_DATABASE_PASSWORD ?? "";
const skip = adminUrl ? false : "set EVERYTHING_TEST_DATABASE_URL to run";

/** A database of its own with every migration before generic credentials applied. */
async function database(context: {
  after: (cleanup: () => Promise<void>) => void;
}) {
  const server = new URL(adminUrl!);
  const admin = new pg.Client({
    host: server.hostname,
    port: Number(server.port || "5432"),
    user: decodeURIComponent(server.username),
    database: server.pathname.slice(1),
    password,
  });
  await admin.connect();
  const name = `key_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const settings = { databaseUrl: url.toString(), databasePassword: password };
  const complete = createApplicationDatabase(settings);
  const migrations = complete.options.migrations as (new () => unknown)[];
  const earlier = new DataSource({
    ...complete.options,
    migrations: migrations.filter(
      (migration) => migration !== GenericCredentials1792886400000,
    ),
  } as typeof complete.options);
  await earlier.initialize();
  await earlier.runMigrations();
  context.after(async () => {
    if (earlier.isInitialized) await earlier.destroy();
    if (complete.isInitialized) await complete.destroy();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { earlier, complete };
}

/** A generic credential record. */
function generic(name: string, ownerId = "owner"): StoredKey {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    ownerId,
    createdAt: now,
    name,
    type: "generic",
    encryptedMaterial: "ciphertext",
    description: "",
    version: 1,
    updatedAt: now,
    deletedAt: null,
  };
}

test(
  "the migration keeps existing SSH keys, enforces names and deletion markers, and refuses unsafe rollback",
  { skip },
  async (context) => {
    const { earlier, complete } = await database(context);
    const ssh = randomUUID();
    await earlier.query(
      "INSERT INTO keys (id, created_at, owner_id, name, type, encrypted_material) VALUES ($1, '2026-01-02T03:04:05Z', 'owner', 'deploy', 'ssh', 'ssh-ciphertext')",
      [ssh],
    );
    await earlier.destroy();
    await complete.initialize();
    await complete.runMigrations();
    const scope = { usage: "installation", actorId: "owner" } as const;
    const keys = new PostgresKeyRepository(complete);
    const existing = await keys.getById(scope, ssh);
    assert.deepEqual(
      {
        version: existing?.version,
        description: existing?.description,
        deletedAt: existing?.deletedAt,
        updatedAt: existing?.updatedAt,
        material: existing?.encryptedMaterial,
      },
      {
        version: 1,
        description: null,
        deletedAt: null,
        updatedAt: "2026-01-02T03:04:05.000Z",
        material: "ssh-ciphertext",
      },
    );
    assert.deepEqual(
      (
        await new PostgresSshKeyRepository(complete).list({
          usage: "installation-ssh",
        })
      ).map(({ id }) => id),
      [ssh],
    );

    const slack = generic("Slack");
    await keys.create(scope, slack);
    await assert.rejects(keys.create(scope, generic("slack")), {
      code: "KEY_NAME_TAKEN",
    });
    await assert.rejects(
      keys.create(
        { ...scope, actorId: "other-owner" },
        generic(" SLACK ".trim(), "other-owner"),
      ),
      { code: "KEY_NAME_TAKEN" },
    );
    // SSH keys keep allowing repeated names.
    await complete.query(
      "INSERT INTO keys (id, owner_id, name, type, encrypted_material) VALUES ($1, 'owner', 'deploy', 'ssh', 'x')",
      [randomUUID()],
    );
    await assert.rejects(
      complete.query("UPDATE keys SET deleted_at = now() WHERE id = $1", [ssh]),
      /keys_deleted_check/,
    );
    await assert.rejects(
      complete.query("UPDATE keys SET deleted_at = now() WHERE id = $1", [
        slack.id,
      ]),
      /keys_deleted_check/,
      "a deletion marker requires the value to be erased",
    );
    await assert.rejects(
      complete.query("UPDATE keys SET version = 0 WHERE id = $1", [slack.id]),
      /keys_version_check/,
    );
    await assert.rejects(
      complete.undoLastMigration(),
      /Delete every generic credential/,
    );
  },
);

test(
  "values are replaced atomically by their creator, and deletion frees the name without reviving the old ID",
  { skip },
  async (context) => {
    const { earlier, complete } = await database(context);
    await earlier.destroy();
    await complete.initialize();
    await complete.runMigrations();
    const scope = { usage: "installation", actorId: "owner" } as const;
    const keys = new PostgresKeyRepository(complete);
    const credentials = new PostgresGenericCredentialRepository(complete);
    const slack = generic("slack-bot-token");
    await keys.create(scope, slack);

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        keys.replaceMaterial(scope, slack.id, `ciphertext-${index}`),
      ),
    );
    assert.equal((await keys.getById(scope, slack.id))?.version, 11);
    assert.equal(
      await keys.replaceMaterial(
        { ...scope, actorId: "other-owner" },
        slack.id,
        "x",
      ),
      undefined,
    );
    assert.equal((await keys.getById(scope, slack.id))?.version, 11);

    assert.deepEqual(
      (
        await credentials.findByName(
          { usage: "credential-grant", ownerId: "owner" },
          "SLACK-BOT-TOKEN",
        )
      ).map(({ id }) => id),
      [slack.id],
    );
    assert.deepEqual(
      await credentials.findByName(
        { usage: "credential-grant", ownerId: "other-owner" },
        "slack-bot-token",
      ),
      [],
    );

    await credentials.purge(slack.id);
    assert.ok(
      await keys.getById(scope, slack.id),
      "a live credential is never purged",
    );
    await keys.markDeleted(scope, slack.id);
    const deleted = await keys.getById(scope, slack.id);
    assert.equal(deleted?.encryptedMaterial, "");
    assert.ok(deleted?.deletedAt);
    assert.equal(await keys.rename(scope, slack.id, "renamed"), undefined);
    assert.equal(
      await keys.replaceMaterial(scope, slack.id, "revived"),
      undefined,
    );
    assert.deepEqual(
      await credentials.findByName(
        { usage: "credential-grant", ownerId: "owner" },
        "slack-bot-token",
      ),
      [],
    );

    const recreated = generic("slack-bot-token");
    await keys.create(scope, recreated);
    assert.notEqual(recreated.id, slack.id);
    assert.deepEqual(
      (await credentials.list({ usage: "credential-sync" })).map(
        ({ id, deletedAt }) => [id, deletedAt !== null],
      ),
      [
        [slack.id, true],
        [recreated.id, false],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    await credentials.purge(slack.id);
    assert.equal(await keys.getById(scope, slack.id), undefined);
    assert.ok(await keys.getById(scope, recreated.id));
  },
);
