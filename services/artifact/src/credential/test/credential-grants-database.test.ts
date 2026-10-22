import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { DataSource } from "typeorm";
import { PostgresArtifactRepository } from "../../artifact/repository/postgres-artifact-repository.js";
import { createArtifactDatabase } from "../../persistence/factory/artifact-database.js";
import {
  CredentialChangedError,
  CredentialRevokedError,
} from "../error/credential-errors.js";
import { PostgresCredentialGrantRepository } from "../repository/postgres-credential-grant-repository.js";

// Runs against a real, disposable PostgreSQL server when ARTIFACT_TEST_DATABASE_URL names one, for
// example postgresql://postgres@127.0.0.1:55432/postgres with ARTIFACT_TEST_DATABASE_PASSWORD. Each
// run creates and drops its own database. Without the variable these tests are skipped.
const adminUrl = process.env.ARTIFACT_TEST_DATABASE_URL;
const password = process.env.ARTIFACT_TEST_DATABASE_PASSWORD ?? "";
const skip = adminUrl ? false : "set ARTIFACT_TEST_DATABASE_URL to run";

/** A migrated database of its own, with repositories, dropped after the test. */
async function database(context: {
  after: (cleanup: () => Promise<void>) => void;
}) {
  const name = `credential_test_${randomUUID().replaceAll("-", "")}`;
  const server = new URL(adminUrl!);
  const admin = new pg.Client({
    host: server.hostname,
    port: Number(server.port || "5432"),
    user: decodeURIComponent(server.username),
    database: server.pathname.slice(1),
    password,
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const source: DataSource = createArtifactDatabase({
    databaseUrl: url.toString(),
    databasePassword: password,
  });
  await source.initialize();
  await source.runMigrations();
  context.after(async () => {
    await source.destroy();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  const artifacts = new PostgresArtifactRepository(source);
  const author = { id: "agent", name: "Ada" };
  /** A new dynamic app of an owner. */
  const app = async (ownerId = "owner") => {
    const created = await artifacts.create(
      { ownerId },
      {
        slug: `app-${randomUUID().slice(0, 8)}`,
        kind: "dynamic",
        title: "App",
        description: "",
      },
      author,
    );
    return { ownerId, artifactId: created.id };
  };
  return {
    source,
    artifacts,
    grants: new PostgresCredentialGrantRepository(source),
    app,
  };
}

test(
  "grants are refused for revoked credentials and older values, but kept and removed freely",
  { skip },
  async (context) => {
    const { grants, app } = await database(context);
    const scope = await app();
    const kept = randomUUID();
    const rotated = randomUUID();
    await grants.replace(scope, [
      { credentialId: kept, env: "KEPT", version: 1 },
      { credentialId: rotated, env: "ROTATED", version: 1 },
    ]);
    assert.equal(await grants.recordVersion(rotated, 2), "current");
    assert.equal(await grants.recordVersion(rotated, 1), "superseded");
    // Removing a grant never fails because another one awaits a newer value.
    await grants.replace(scope, [
      { credentialId: rotated, env: "ROTATED", version: 1 },
    ]);
    // Re-adding a current grant succeeds; the unchanged, outdated one beside it isn't re-checked.
    await grants.replace(scope, [
      { credentialId: rotated, env: "ROTATED", version: 1 },
      { credentialId: kept, env: "KEPT", version: 1 },
    ]);
    await grants.replace(scope, [
      { credentialId: rotated, env: "ROTATED", version: 1 },
    ]);
    await assert.rejects(
      grants.replace(scope, [
        { credentialId: rotated, env: "OTHER", version: 1 },
      ]),
      CredentialChangedError,
    );
    await grants.advance(scope, rotated, 2);
    await grants.advance(scope, rotated, 1);
    assert.deepEqual(
      (await grants.list(scope)).map(({ env, version }) => [env, version]),
      [["ROTATED", 2]],
      "advancing never lowers a version",
    );
    assert.deepEqual(await grants.revoke(rotated), [scope]);
    assert.deepEqual(await grants.list(scope), []);
    await assert.rejects(
      grants.replace(scope, [
        { credentialId: rotated, env: "ROTATED", version: 9 },
      ]),
      CredentialRevokedError,
    );
    await assert.rejects(
      grants.recordVersion(rotated, 10),
      CredentialRevokedError,
    );
    const [record] = await grants.records([rotated]);
    assert.ok(record?.revokedAt);
  },
);

test(
  "a grant racing a revocation never survives it",
  { skip },
  async (context) => {
    const { grants, app } = await database(context);
    const scopes = await Promise.all(Array.from({ length: 4 }, () => app()));
    for (let round = 0; round < 25; round += 1) {
      const credentialId = randomUUID();
      const results = await Promise.allSettled([
        ...scopes.map((scope) =>
          grants.replace(scope, [{ credentialId, env: "TOKEN", version: 1 }]),
        ),
        grants.revoke(credentialId),
      ]);
      for (const result of results.slice(0, -1))
        if (result.status === "rejected")
          assert.ok(
            result.reason instanceof CredentialRevokedError,
            String(result.reason),
          );
      assert.equal(results.at(-1)!.status, "fulfilled");
      assert.deepEqual(
        await grants.list({ credentialId }),
        [],
        `round ${round}: a grant outlived its revocation`,
      );
    }
  },
);

test(
  "out-of-order deliveries leave the newest version recorded",
  { skip },
  async (context) => {
    const { grants } = await database(context);
    for (let round = 0; round < 10; round += 1) {
      const credentialId = randomUUID();
      const versions = [3, 1, 4, 2, 5].sort(() => Math.random() - 0.5);
      await Promise.allSettled(
        versions.map((version) => grants.recordVersion(credentialId, version)),
      );
      const [record] = await grants.records([credentialId]);
      assert.equal(record?.version, 5);
    }
  },
);

test(
  "the database refuses malformed grants and removes grants, not records, with their app",
  { skip },
  async (context) => {
    const { source, artifacts, grants, app } = await database(context);
    const scope = await app();
    const credentialId = randomUUID();
    await grants.replace(scope, [{ credentialId, env: "TOKEN", version: 1 }]);
    for (const [env, version] of [
      ["1BAD", 1],
      ["TOKEN_TWO", 0],
    ] as const)
      await assert.rejects(
        source.query(
          "INSERT INTO app_credential_bindings (id, owner_id, artifact_id, credential_id, env, version) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            randomUUID(),
            scope.ownerId,
            scope.artifactId,
            credentialId,
            env,
            version,
          ],
        ),
        /check constraint/,
      );
    await assert.rejects(
      source.query(
        "INSERT INTO app_credential_bindings (id, owner_id, artifact_id, credential_id, env, version) VALUES ($1, $2, $3, $4, 'TOKEN', 1)",
        [randomUUID(), scope.ownerId, scope.artifactId, randomUUID()],
      ),
      /app_credential_bindings_env/,
    );
    await artifacts.delete({ ownerId: scope.ownerId }, scope.artifactId);
    assert.deepEqual(await grants.list({ credentialId }), []);
    assert.equal((await grants.records([credentialId])).length, 1);
  },
);

test(
  "scopes keep one owner's grants from another's",
  { skip },
  async (context) => {
    const { grants, app } = await database(context);
    const mine = await app("owner");
    const theirs = await app("other-owner");
    const credentialId = randomUUID();
    await grants.replace(mine, [{ credentialId, env: "TOKEN", version: 1 }]);
    await grants.replace(theirs, [
      { credentialId: randomUUID(), env: "TOKEN", version: 1 },
    ]);
    assert.equal((await grants.list({ ownerId: "owner" })).length, 1);
    assert.deepEqual(
      await grants.list({
        ownerId: "other-owner",
        artifactId: mine.artifactId,
      }),
      [],
    );
    await grants.advance(
      { ownerId: "other-owner", artifactId: mine.artifactId },
      credentialId,
      5,
    );
    assert.equal((await grants.list(mine))[0]!.version, 1);
    assert.equal((await grants.list({ inventory: true })).length, 2);
  },
);
