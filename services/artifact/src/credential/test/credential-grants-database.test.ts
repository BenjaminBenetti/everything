import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { DataSource } from "typeorm";
import { PostgresArtifactRepository } from "../../artifact/repository/postgres-artifact-repository.js";
import { createArtifactDatabase } from "../../persistence/factory/artifact-database.js";
import {
  CredentialChangedError,
  CredentialGrantsChangedError,
  CredentialRevokedError,
  CredentialValueConflictError,
} from "../error/credential-errors.js";
import type { CredentialGrantRepository } from "../interface/credential-grant-repository.js";
import type { NewCredentialBinding } from "../model/credential-binding.js";
import { PostgresReleaseStore } from "../../deployment/repository/postgres-release-store.js";
import { PostgresAppApiKeyRepository } from "../../capability/repository/postgres-app-api-key-repository.js";
import { PostgresDeploymentRepository } from "../../deployment/repository/postgres-deployment-repository.js";
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
  const url = new URL(server);
  url.pathname = `/${name}`;
  const source: DataSource = createArtifactDatabase({
    databaseUrl: url.toString(),
    databasePassword: password,
  });
  // Clean up even when a later step fails; an open connection would keep the test process alive.
  let connected = false;
  context.after(async () => {
    if (source.isInitialized) await source.destroy();
    if (connected)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  await admin.connect();
  connected = true;
  await admin.query(`CREATE DATABASE ${name}`);
  await source.initialize();
  await source.runMigrations();
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

/** Value identities by credential and version, as Everything would assign them. */
const identities = new Map<string, string>();

/** A grant of a credential at a version, with that version's value identity. */
function grant(
  credentialId: string,
  env: string,
  version: number,
  valueId = identities.get(`${credentialId}@${version}`) ?? randomUUID(),
): NewCredentialBinding {
  identities.set(`${credentialId}@${version}`, valueId);
  return { credentialId, env, version, valueId };
}

/** Change grants as Everything does, naming the generation read just before. */
async function replace(
  grants: CredentialGrantRepository,
  scope: { ownerId: string; artifactId: string },
  bindings: NewCredentialBinding[],
): Promise<number> {
  const generation = (await grants.generations([scope.artifactId])).get(
    scope.artifactId,
  );
  return grants.replace(scope, { bindings, expectedGeneration: generation });
}

test(
  "grants are refused for revoked credentials, older values, and a second value at one version, but kept and removed freely",
  { skip },
  async (context) => {
    const { grants, app } = await database(context);
    const scope = await app();
    const kept = randomUUID();
    const rotated = randomUUID();
    await replace(grants, scope, [
      grant(kept, "KEPT", 1),
      grant(rotated, "ROTATED", 1),
    ]);
    const second = randomUUID();
    assert.equal(await grants.recordVersion(rotated, 2, second), "current");
    identities.set(`${rotated}@2`, second);
    assert.equal(
      await grants.recordVersion(rotated, 1, identities.get(`${rotated}@1`)!),
      "superseded",
    );
    assert.equal(
      await grants.recordVersion(rotated, 2, randomUUID()),
      "conflict",
      "a version is never accepted with a second value",
    );
    // Removing a grant never fails because another one awaits a newer value.
    await replace(grants, scope, [grant(rotated, "ROTATED", 1)]);
    // Re-adding a current grant succeeds; the unchanged, outdated one beside it isn't re-checked.
    await replace(grants, scope, [
      grant(rotated, "ROTATED", 1),
      grant(kept, "KEPT", 1),
    ]);
    await replace(grants, scope, [grant(rotated, "ROTATED", 1)]);
    await assert.rejects(
      replace(grants, scope, [grant(rotated, "OTHER", 1)]),
      CredentialChangedError,
    );
    await assert.rejects(
      replace(grants, scope, [grant(rotated, "OTHER", 2, randomUUID())]),
      CredentialValueConflictError,
    );
    await grants.advance(scope, rotated, 2, second);
    await grants.advance(scope, rotated, 1, identities.get(`${rotated}@1`)!);
    assert.deepEqual(
      (await grants.list(scope)).map(({ env, version, valueId }) => [
        env,
        version,
        valueId,
      ]),
      [["ROTATED", 2, second]],
      "advancing never lowers a version",
    );
    assert.deepEqual(await grants.revoke(rotated), [scope]);
    assert.deepEqual(await grants.list(scope), []);
    await assert.rejects(
      replace(grants, scope, [grant(rotated, "ROTATED", 9)]),
      CredentialRevokedError,
    );
    await assert.rejects(
      grants.recordVersion(rotated, 10, randomUUID()),
      CredentialRevokedError,
    );
    const [record] = await grants.records([rotated]);
    assert.ok(record?.revokedAt);
  },
);

test(
  "a grant authorized before a removal is refused after it; a fresh one is accepted",
  { skip },
  async (context) => {
    const { grants, app } = await database(context);
    const scope = await app();
    const token = randomUUID();
    assert.equal(await replace(grants, scope, [grant(token, "TOKEN", 1)]), 1);
    // A deploy or attachment is authorized against generation 1, then delayed.
    const authorizedAt = (await grants.generations([scope.artifactId])).get(
      scope.artifactId,
    );
    assert.equal(authorizedAt, 1);
    // The credential is detached: removal needs no generation and advances it.
    assert.equal(
      await grants.replace(scope, {
        bindings: [],
        expectedGeneration: undefined,
      }),
      2,
    );
    await assert.rejects(
      grants.replace(scope, {
        bindings: [grant(token, "TOKEN", 1)],
        expectedGeneration: authorizedAt,
      }),
      CredentialGrantsChangedError,
    );
    await assert.rejects(
      grants.replace(scope, {
        bindings: [grant(token, "TOKEN", 1)],
        expectedGeneration: undefined,
      }),
      CredentialGrantsChangedError,
      "a grant that names no generation is refused",
    );
    assert.deepEqual(await grants.list(scope), []);
    // Reauthorizing after the removal reads the new generation and succeeds.
    assert.equal(await replace(grants, scope, [grant(token, "TOKEN", 1)]), 3);
    // Unchanged grants need no generation and don't advance it.
    assert.equal(
      await grants.replace(scope, {
        bindings: [grant(token, "TOKEN", 1)],
        expectedGeneration: undefined,
      }),
      3,
    );
    // Revocation advances every affected app.
    await grants.revoke(token);
    assert.equal(
      (await grants.generations([scope.artifactId])).get(scope.artifactId),
      4,
    );
  },
);

test(
  "concurrent grants authorized against one generation commit at most once",
  { skip },
  async (context) => {
    const { grants, app } = await database(context);
    const scope = await app();
    for (let round = 0; round < 10; round += 1) {
      const authorizedAt = (await grants.generations([scope.artifactId])).get(
        scope.artifactId,
      );
      const results = await Promise.allSettled(
        ["A", "B", "C"].map((env) =>
          grants.replace(scope, {
            bindings: [grant(randomUUID(), env, 1)],
            expectedGeneration: authorizedAt,
          }),
        ),
      );
      const committed = results.filter(
        (result) => result.status === "fulfilled",
      );
      assert.ok(committed.length <= 1, `round ${round}`);
      for (const result of results)
        if (result.status === "rejected")
          assert.ok(
            result.reason instanceof CredentialGrantsChangedError ||
              serializationFailure(result.reason),
            String(result.reason),
          );
      assert.ok((await grants.list(scope)).length <= 1);
    }
  },
);

/** Whether PostgreSQL gave up on a transaction after its retries; the change didn't happen. */
function serializationFailure(error: unknown): boolean {
  return ["40001", "40P01"].includes(
    (error as { driverError?: { code?: string } }).driverError?.code ?? "",
  );
}

test(
  "a grant racing a revocation never survives it",
  { skip },
  async (context) => {
    const { grants, app } = await database(context);
    const scopes = await Promise.all(Array.from({ length: 4 }, () => app()));
    const outcomes = {
      granted: 0,
      refused: 0,
      gaveUp: 0,
      revocationRetried: 0,
    };
    for (let round = 0; round < 25; round += 1) {
      const credentialId = randomUUID();
      const generations = await grants.generations(
        scopes.map((scope) => scope.artifactId),
      );
      const results = await Promise.allSettled([
        ...scopes.map((scope) =>
          grants.replace(scope, {
            bindings: [grant(credentialId, "TOKEN", 1)],
            expectedGeneration: generations.get(scope.artifactId),
          }),
        ),
        grants.revoke(credentialId),
      ]);
      for (const result of results.slice(0, -1))
        if (result.status === "fulfilled") outcomes.granted += 1;
        else if (result.reason instanceof CredentialRevokedError)
          outcomes.refused += 1;
        else {
          assert.ok(
            serializationFailure(result.reason) ||
              result.reason instanceof CredentialGrantsChangedError,
            `round ${round}: unexpected grant failure ${String(result.reason)}`,
          );
          outcomes.gaveUp += 1;
        }
      // A revocation that gave up is retried, as Everything's synchronization does.
      const revocation = results.at(-1)!;
      if (revocation.status === "rejected") {
        assert.ok(
          serializationFailure(revocation.reason),
          String(revocation.reason),
        );
        outcomes.revocationRetried += 1;
        await grants.revoke(credentialId);
      }
      assert.deepEqual(
        await grants.list({ credentialId }),
        [],
        `round ${round}: a grant outlived its revocation`,
      );
    }
    context.diagnostic(JSON.stringify(outcomes));
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
        versions.map((version) =>
          grants.recordVersion(credentialId, version, randomUUID()),
        ),
      );
      const [record] = await grants.records([credentialId]);
      assert.equal(record?.version, 5);
    }
  },
);

test(
  "a release's grants, key revocation, deployment, and live release commit together or not at all",
  { skip },
  async (context) => {
    const { source, artifacts, grants, app } = await database(context);
    const scope = await app();
    const releases = new PostgresReleaseStore(source);
    const keys = new PostgresAppApiKeyRepository(source);
    const deployments = new PostgresDeploymentRepository(source);
    const author = { id: "agent", name: "Ada" };
    const deployment = (release: number, env: Record<string, string>) => ({
      release,
      author,
      build: 1,
      imageDigest: `sha256:${"a".repeat(64)}`,
      port: 8080,
      env,
      database: false,
      capabilities: [] as const,
      diskGi: null,
      healthPath: null,
    });
    await releases.commit(scope, {
      grants: undefined,
      revokeApiKey: false,
      deployment: deployment(1, { TOKEN: "ordinary" }),
      changes: {
        release: 1,
        liveDeployment: 1,
        running: true,
        updatedBy: author,
      },
    });
    await keys.replace(scope, "a".repeat(64));
    const token = randomUUID();
    // The deployment fails after its grants were written: release 1 already exists.
    await assert.rejects(
      releases.commit(scope, {
        grants: {
          bindings: [grant(token, "TOKEN", 1)],
          expectedGeneration: 0,
        },
        revokeApiKey: true,
        deployment: deployment(1, {}),
        changes: {
          release: 2,
          liveDeployment: 2,
          running: true,
          updatedBy: author,
        },
      }),
      /artifact_deployments_release|duplicate key/,
    );
    assert.deepEqual(await grants.list(scope), [], "no grant took effect");
    assert.equal(
      (await grants.generations([scope.artifactId])).get(scope.artifactId),
      0,
    );
    assert.ok(await keys.find(scope), "the key wasn't revoked");
    assert.deepEqual((await grants.records([token])).length, 0);
    const live = await artifacts.getById(
      { ownerId: scope.ownerId },
      scope.artifactId,
    );
    assert.equal(live?.liveDeployment, 1);
    assert.deepEqual((await deployments.findByRelease(scope, 1))?.env, {
      TOKEN: "ordinary",
    });
    // The same release, correctly numbered, commits everything at once.
    const updated = await releases.commit(scope, {
      grants: { bindings: [grant(token, "TOKEN", 1)], expectedGeneration: 0 },
      revokeApiKey: true,
      deployment: deployment(2, {}),
      changes: {
        release: 2,
        liveDeployment: 2,
        running: true,
        updatedBy: author,
      },
    });
    assert.equal(updated.liveDeployment, 2);
    assert.deepEqual(
      (await grants.list(scope)).map(({ env }) => env),
      ["TOKEN"],
    );
    assert.equal(await keys.find(scope), undefined);
  },
);
test(
  "the database refuses malformed grants and removes grants, not records, with their app",
  { skip },
  async (context) => {
    const { source, artifacts, grants, app } = await database(context);
    const scope = await app();
    const credentialId = randomUUID();
    await replace(grants, scope, [grant(credentialId, "TOKEN", 1)]);
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
    await replace(grants, mine, [grant(credentialId, "TOKEN", 1)]);
    await replace(grants, theirs, [grant(randomUUID(), "TOKEN", 1)]);
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
      randomUUID(),
    );
    assert.equal((await grants.list(mine))[0]!.version, 1);
    assert.equal((await grants.list({ inventory: true })).length, 2);
  },
);
