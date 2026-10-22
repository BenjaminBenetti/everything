import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AppCredentialGrant } from "@everything/artifact-contracts/credential";
import { ArtifactLifecycleService } from "../../artifact/service/artifact-lifecycle-service.js";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import { WrongKindError } from "../../artifact/error/artifact-errors.js";
import {
  ada,
  file,
  MemoryArtifacts,
  MemoryBuilds,
  MemoryDeployments,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import { DeploymentService } from "../../deployment/service/deployment-service.js";
import { WorkloadReconciler } from "../../deployment/service/workload-reconciler.js";
import {
  CredentialChangedError,
  CredentialRevokedError,
  CredentialSupersededError,
  CredentialVariableConflictError,
  DuplicateCredentialVariableError,
  InvalidCredentialError,
  InvalidCredentialVariableError,
  ReservedCredentialVariableError,
  TooManyCredentialsError,
} from "../error/credential-errors.js";
import { AppCredentials } from "../service/app-credentials.js";
import { CredentialDistribution } from "../service/credential-distribution.js";
import {
  MemoryCredentialGrants,
  MemoryCredentialSecrets,
  SimulatedCluster,
} from "./credential-fixture.js";

// These tests drive the real services against a simulated cluster. They show which processes the
// service keeps, replaces, and reports; they are not evidence of real container injection.

/** A value with the characters most likely to be altered on its way to a process. */
const sentinel =
  "  sentinel-A-7f3c\nline two $HOME `id` \\ 'single' \"double\" ü 🔑\r\n\t ";
const rotated = "sentinel-A-rotated-91b2";
const digest = `sha256:${"a".repeat(64)}`;

/** Services over in-memory storage and a simulated cluster, with one dynamic app and two builds. */
async function world() {
  const artifacts = new MemoryArtifacts();
  const builds = new MemoryBuilds();
  const deployments = new MemoryDeployments();
  const grants = new MemoryCredentialGrants();
  const secrets = new MemoryCredentialSecrets();
  const cluster = new SimulatedCluster(secrets);
  const lock = new ArtifactLock();
  const lookup = new ArtifactLookup(artifacts);
  const app = artifacts.add("dynamic", "planner");
  const scope = { ownerId: owner, artifactId: app.id };
  for (const number of [1, 2]) {
    const build = await builds.create(scope, {
      number,
      author: ada,
      dockerfile: "Dockerfile",
      buildArgs: {},
      files: [file("Dockerfile")],
      totalSize: 10,
      sourceTokenHash: `token-${number}`,
    });
    await builds.record(scope, build.id, {
      status: "succeeded",
      imageDigest: digest,
    });
  }
  /** Dependencies needed only to build a replacement, which a test can make fail. */
  const faults = { database: false, capabilities: false };
  const reconciler = new WorkloadReconciler(
    artifacts,
    deployments,
    cluster,
    {
      ensure: async (id, password) => {
        if (faults.database) throw new Error("PostgreSQL is unavailable");
        return { host: "db", port: 5432, database: "data", user: id, password };
      },
      remove: async () => {},
    },
    "registry.test",
    {
      reconcile: async () => {
        if (faults.capabilities) throw new Error("Keycloak is unavailable");
        return { secretNames: [], fingerprint: null };
      },
      remove: async () => {
        if (faults.capabilities) throw new Error("Keycloak is unavailable");
      },
    },
    lock,
    grants,
    secrets,
  );
  const credentials = new AppCredentials(
    grants,
    secrets,
    cluster,
    artifacts,
    deployments,
    reconciler,
    lookup,
    lock,
  );
  const deploy = new DeploymentService(
    artifacts,
    deployments,
    builds,
    reconciler,
    { logs: async () => `token=${sentinel}; rotated=${rotated}` },
    lookup,
    lock,
    { revoke: async () => {} },
    credentials,
  );
  const distribution = new CredentialDistribution(
    grants,
    secrets,
    artifacts,
    cluster,
    reconciler,
    lock,
  );
  const lifecycle = new ArtifactLifecycleService(
    artifacts,
    lookup,
    lock,
    reconciler,
  );
  /** The app's credential states as listings report them. */
  const states = async () =>
    (await credentials.states([(await artifacts.getById(scope, app.id))!])).get(
      app.id,
    ) ?? [];
  return {
    app,
    artifacts,
    cluster,
    faults,
    credentials,
    deploy,
    deployments,
    distribution,
    grants,
    lifecycle,
    reconciler,
    scope,
    secrets,
    states,
  };
}

/** A grant of a credential under a variable. */
function grant(
  credentialId: string,
  env: string,
  version = 1,
  value = sentinel,
): AppCredentialGrant {
  return { credentialId, env, version, value };
}

/** Everything the platform recorded or applied, as text, to search for a value. */
function platformRecords(context: Awaited<ReturnType<typeof world>>): string {
  return JSON.stringify([
    context.deployments.records,
    context.grants.bindings,
    [...context.grants.credentialRecords.values()],
    context.cluster.applied,
    context.cluster.pods.map(({ environment: _environment, ...pod }) => pod),
  ]);
}

test("a deployed credential reaches the process exactly, through a versioned Secret and never the manifest or history", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "SLACK_BOT_TOKEN")],
  });
  assert.equal((await context.states())[0]!.status, "pending");
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [
    { SLACK_BOT_TOKEN: sentinel },
  ]);
  assert.deepEqual(await context.states(), [
    {
      credentialId: slack,
      name: null,
      env: "SLACK_BOT_TOKEN",
      version: 1,
      status: "applied",
    },
  ]);
  assert.ok(!platformRecords(context).includes("sentinel-A"));
  assert.ok(!JSON.stringify(context.deployments.records).includes(slack));
});

test("omitted credentials keep the current grants; an empty list removes them and replaces the process", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "SLACK_BOT_TOKEN")],
  });
  context.cluster.settle();
  await context.deploy.deploy(owner, ada, "planner", { build: 2 });
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [
    { SLACK_BOT_TOKEN: sentinel },
  ]);
  assert.deepEqual(context.cluster.stops, []);

  await context.deploy.deploy(owner, ada, "planner", { credentials: [] });
  assert.deepEqual(context.cluster.stops, [context.app.id]);
  assert.deepEqual(
    (await context.states()).map(({ env, status }) => [env, status]),
    [["SLACK_BOT_TOKEN", "removing"]],
    "the stopping process still holds the value until it exits",
  );
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [{}]);
  assert.deepEqual(await context.states(), []);
  assert.equal(context.secrets.secrets.size, 0);
});

test("detaching replaces the process even when its replacement never becomes ready", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.credentials.attach(
    owner,
    ada,
    "planner",
    grant(slack, "TOKEN"),
  );
  await context.deploy.deploy(owner, ada, "planner", {});
  context.cluster.settle();
  context.cluster.newPodsFail = true;
  await context.credentials.detach(owner, ada, "planner", "TOKEN");
  context.cluster.settle();
  assert.ok(
    context.cluster.environments(context.app.id).every((env) => !env.TOKEN),
    "a rolling update would have kept the old process while the new one fails",
  );
  assert.deepEqual(await context.states(), []);
});

test("a rotated value replaces old processes, reports pending until observed, and refuses older deliveries", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "TOKEN")],
  });
  context.cluster.settle();

  const delivered = await context.distribution.deliver(slack, {
    version: 2,
    value: rotated,
  });
  assert.equal(delivered.complete, true);
  assert.deepEqual(
    delivered.apps.map(({ env, version, status }) => [env, version, status]),
    [["TOKEN", 2, "pending"]],
  );
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [
    { TOKEN: rotated },
  ]);
  assert.equal((await context.states())[0]!.status, "applied");
  assert.deepEqual(
    [...context.secrets.secrets.values()].map((secret) => secret.version),
    [2],
    "the old version's copy is deleted",
  );

  await assert.rejects(
    context.distribution.deliver(slack, { version: 1, value: sentinel }),
    CredentialSupersededError,
  );
  await assert.rejects(
    context.deploy.deploy(owner, ada, "planner", {
      credentials: [grant(slack, "TOKEN", 1, sentinel)],
    }),
    CredentialChangedError,
  );
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [
    { TOKEN: rotated },
  ]);
});

test("rolling back to an earlier build keeps current grants, so a detached credential stays detached", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.credentials.attach(
    owner,
    ada,
    "planner",
    grant(slack, "TOKEN"),
  );
  await context.deploy.deploy(owner, ada, "planner", { build: 1 });
  context.cluster.settle();
  await context.credentials.detach(owner, ada, "planner", "TOKEN");
  context.cluster.settle();
  await context.deploy.deploy(owner, ada, "planner", { build: 1 });
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [{}]);
  assert.deepEqual(await context.states(), []);
});

test("a deleted credential is revoked everywhere and can never be granted again, even under a reused name", async () => {
  const context = await world();
  const deleted = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(deleted, "TOKEN")],
  });
  context.cluster.settle();

  const revoked = await context.distribution.revoke(deleted);
  assert.equal(revoked.complete, false, "the old process hasn't stopped yet");
  assert.deepEqual(
    revoked.apps.map(({ env, status }) => [env, status]),
    [["TOKEN", "removing"]],
  );
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [{}]);
  assert.deepEqual(await context.distribution.uses(deleted), []);
  assert.equal((await context.distribution.revoke(deleted)).complete, true);

  // A deployment prepared before the deletion arrives late.
  await assert.rejects(
    context.deploy.deploy(owner, ada, "planner", {
      credentials: [grant(deleted, "TOKEN")],
    }),
    CredentialRevokedError,
  );
  await assert.rejects(
    context.distribution.deliver(deleted, { version: 2, value: rotated }),
    CredentialRevokedError,
  );
  assert.equal(
    context.secrets.secrets.size,
    0,
    "the refused value isn't left in the cluster",
  );
  // A new credential with the old name has a new ID; rolling back never attaches it.
  await context.deploy.deploy(owner, ada, "planner", { build: 1 });
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [{}]);
  assert.equal(context.secrets.secrets.size, 0);
});

test("a stopped app keeps its grants and starts with the value delivered while it was stopped", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "TOKEN")],
  });
  context.cluster.settle();
  await context.lifecycle.stop(owner, ada, "planner");
  context.cluster.settle();
  assert.equal((await context.states())[0]!.status, "stopped");
  await context.distribution.deliver(slack, { version: 2, value: rotated });
  assert.equal(context.cluster.pods.length, 0, "delivery doesn't start it");
  await context.lifecycle.start(owner, ada, "planner");
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [
    { TOKEN: rotated },
  ]);
});

test("invalid, reserved, duplicate, and colliding variables are refused before anything changes", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", { env: { MODE: "demo" } });
  const releases = context.deployments.records.length;
  const cases: [AppCredentialGrant[], new (...args: never[]) => Error][] = [
    [[grant(slack, "1TOKEN")], InvalidCredentialVariableError],
    [[grant(slack, `T${"A".repeat(128)}`)], InvalidCredentialVariableError],
    [[grant(slack, "PORT")], ReservedCredentialVariableError],
    [[grant(slack, "DATABASE_URL")], ReservedCredentialVariableError],
    [[grant(slack, "APP_API_KEY")], ReservedCredentialVariableError],
    [[grant(slack, "PGSSLMODE")], ReservedCredentialVariableError],
    [[grant(slack, "EVERYTHING_TOKEN")], ReservedCredentialVariableError],
    [
      [grant(slack, "KUBERNETES_SERVICE_HOST")],
      ReservedCredentialVariableError,
    ],
    [
      [grant(slack, "TOKEN"), grant(randomUUID(), "TOKEN")],
      DuplicateCredentialVariableError,
    ],
    [[grant(slack, "MODE")], CredentialVariableConflictError],
    [[grant(slack, "TOKEN", 1, "a\0b")], InvalidCredentialError],
    [[grant(slack, "TOKEN", 1, "\uD800")], InvalidCredentialError],
    [[grant(slack, "TOKEN", 1, "é".repeat(16385))], InvalidCredentialError],
    [
      Array.from({ length: 17 }, (_, index) =>
        grant(randomUUID(), `TOKEN_${index}`),
      ),
      TooManyCredentialsError,
    ],
  ];
  for (const [credentials, expected] of cases)
    await assert.rejects(
      context.deploy.deploy(owner, ada, "planner", { credentials }),
      expected,
    );
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "TOKEN")],
  });
  await assert.rejects(
    context.deploy.deploy(owner, ada, "planner", { env: { TOKEN: "x" } }),
    CredentialVariableConflictError,
    "an ordinary variable can't later shadow a kept credential",
  );
  await assert.rejects(
    context.credentials.attach(
      owner,
      ada,
      "planner",
      grant(randomUUID(), "MODE"),
    ),
    CredentialVariableConflictError,
  );
  assert.equal(context.deployments.records.length, releases + 1);
  assert.deepEqual(
    context.grants.bindings.map(({ env }) => env),
    ["TOKEN"],
  );
  assert.equal(context.secrets.secrets.size, 1);
});

test("static apps can't receive credentials", async () => {
  const context = await world();
  context.artifacts.add("static", "report", { liveRevision: 1 });
  await assert.rejects(
    context.credentials.attach(
      owner,
      ada,
      "report",
      grant(randomUUID(), "TOKEN"),
    ),
    WrongKindError,
  );
  await assert.rejects(
    context.deploy.deploy(owner, ada, "report", {
      credentials: [grant(randomUUID(), "TOKEN")],
    }),
    WrongKindError,
  );
  assert.equal(context.grants.bindings.length, 0);
  assert.equal(context.secrets.secrets.size, 0);
});

test("a failed Secret write leaves grants and releases unchanged", async () => {
  const context = await world();
  context.secrets.failWrites = true;
  await assert.rejects(
    context.deploy.deploy(owner, ada, "planner", {
      credentials: [grant(randomUUID(), "TOKEN")],
    }),
    /Secret write failed/,
  );
  assert.equal(context.grants.bindings.length, 0);
  assert.equal(context.deployments.records.length, 0);
});

test("revocation reports removal pending, not done, while the runtime can't stop the old process", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "TOKEN")],
  });
  context.cluster.settle();
  const stop = context.cluster.stop.bind(context.cluster);
  context.cluster.stop = async () => {
    throw new Error("Kubernetes is unavailable");
  };
  const revoked = await context.distribution.revoke(slack);
  assert.equal(revoked.complete, false);
  assert.deepEqual(
    revoked.apps.map(({ status }) => status),
    ["removing"],
  );
  assert.deepEqual(context.cluster.environments(context.app.id), [
    { TOKEN: sentinel },
  ]);
  // Periodic reconciliation finishes the job once the runtime answers.
  context.cluster.stop = stop;
  await context.reconciler.reconcileAll();
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [{}]);
  assert.equal((await context.distribution.revoke(slack)).complete, true);
});

test("a missing copy is reported and healed by delivering the value again", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "TOKEN")],
  });
  context.cluster.settle();
  context.secrets.secrets.clear();
  assert.equal((await context.states())[0]!.status, "missing");
  const [entry] = await context.distribution.inventory();
  assert.deepEqual(entry, {
    credentialId: slack,
    oldestVersion: 1,
    missing: true,
    held: true,
    revoked: false,
  });
  const healed = await context.distribution.deliver(slack, {
    version: 1,
    value: sentinel,
  });
  assert.equal(healed.complete, true);
  context.cluster.settle();
  assert.equal((await context.states())[0]!.status, "applied");
});

test("logs hide exact copies of the app's current credential values", async () => {
  const context = await world();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(randomUUID(), "TOKEN")],
  });
  const logs = await context.deploy.logs(owner, "planner", {
    previous: false,
    lines: 10,
  });
  assert.ok(!logs.includes("sentinel-A-7f3c"));
  assert.match(logs, /token=\[credential TOKEN\]; rotated=sentinel-A-rotated/);
});

test("deleting an app removes its credential copies", async () => {
  const context = await world();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(randomUUID(), "TOKEN")],
  });
  await context.reconciler.remove(
    (await context.artifacts.getById(context.scope, context.app.id))!,
  );
  assert.equal(context.secrets.secrets.size, 0);
  assert.equal(
    context.cluster.pods.every((pod) => pod.terminating),
    true,
  );
});

test("withdrawing a credential stops its holders even when the database, capabilities, or new workload can't be provisioned", async () => {
  for (const fault of ["database", "capabilities", "apply"] as const) {
    const context = await world();
    const slack = randomUUID();
    await context.deploy.deploy(owner, ada, "planner", {
      database: true,
      credentials: [grant(slack, "TOKEN")],
    });
    context.cluster.settle();
    if (fault === "apply") context.cluster.failApply = true;
    else context.faults[fault] = true;
    await context.credentials
      .detach(owner, ada, "planner", "TOKEN")
      .catch(() => undefined);
    assert.ok(
      context.cluster.pods.every((pod) => pod.terminating),
      `${fault}: the holder is stopped before anything else is provisioned`,
    );
    assert.deepEqual(
      (await context.states()).map(({ env, status }) => [env, status]),
      [["TOKEN", "removing"]],
      `${fault}: removal stays pending until the process exits`,
    );
    context.cluster.settle();
    assert.ok(
      context.cluster.environments(context.app.id).every((env) => !env.TOKEN),
      fault,
    );
    assert.equal(context.secrets.secrets.size, 0, `${fault}: copy deleted`);
  }
});

test("rotation and deletion stop old holders even when provisioning fails", async () => {
  const context = await world();
  const slack = randomUUID();
  await context.deploy.deploy(owner, ada, "planner", {
    credentials: [grant(slack, "TOKEN")],
  });
  context.cluster.settle();
  context.faults.capabilities = true;
  await context.distribution.deliver(slack, { version: 2, value: rotated });
  assert.ok(context.cluster.pods.every((pod) => pod.terminating));
  context.cluster.settle();
  context.faults.capabilities = false;
  await context.reconciler.reconcileAll();
  context.cluster.settle();
  assert.deepEqual(context.cluster.environments(context.app.id), [
    { TOKEN: rotated },
  ]);

  context.faults.capabilities = true;
  await assert.rejects(
    context.reconciler.remove(
      (await context.artifacts.getById(context.scope, context.app.id))!,
    ),
    /Keycloak/,
  );
  assert.ok(
    context.cluster.pods.every((pod) => pod.terminating),
    "deleting an app stops its processes before revoking its clients",
  );
  assert.equal(context.secrets.secrets.size, 0);
});
