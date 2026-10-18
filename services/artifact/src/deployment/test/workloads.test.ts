import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactRuntime } from "@everything/artifact-contracts";
import {
  ada,
  MemoryArtifacts,
  MemoryDeployments,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import type { DatabaseConnection } from "../../database/interface/artifact-databases.js";
import {
  databaseSecretManifest,
  deploymentManifest,
  statefulSetManifest,
} from "../adapter/workload-manifests.js";
import type {
  ArtifactWorkload,
  WorkloadOrchestrator,
} from "../interface/workload-orchestrator.js";
import { runtimeFromPods } from "../model/runtime-state.js";
import { WorkloadReconciler } from "../service/workload-reconciler.js";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";

const settings = {
  namespace: "artifacts",
  pullSecret: "registry-pull",
  storageClassName: "",
};
const artifactId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** A workload with the given settings. */
function workload(
  changes: Partial<ArtifactWorkload["settings"]> = {},
): ArtifactWorkload {
  return {
    artifactId,
    slug: "app",
    image: "localhost:30500/artifacts/x@sha256:abc",
    settings: {
      port: 3000,
      env: { MODE: "demo", PORT: "1" },
      database: false,
      capabilities: [],
      diskGi: null,
      healthPath: null,
      ...changes,
    },
    release: 4,
    databaseFingerprint: null,
    capabilities: { secretNames: [], fingerprint: null },
  };
}

test("artifact pods run unprivileged, with the service's variables last and a pull secret", () => {
  const manifest = deploymentManifest(workload(), settings);
  const pod = manifest.spec!.template.spec!;
  const container = pod.containers[0]!;
  assert.equal(
    manifest.metadata!.name,
    "artifact-6f1c1f6e8c7e4c4b9a432d8b8f7c8f11",
  );
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.imagePullSecrets, [{ name: "registry-pull" }]);
  assert.equal(pod.securityContext!.runAsNonRoot, true);
  assert.deepEqual(container.securityContext!.capabilities, { drop: ["ALL"] });
  assert.equal(container.securityContext!.allowPrivilegeEscalation, false);
  assert.deepEqual(container.env!.slice(-2), [
    { name: "PORT", value: "3000" },
    { name: "BASE_PATH", value: "/app" },
  ]);
  assert.deepEqual(container.readinessProbe!.tcpSocket, { port: "http" });
  assert.equal(container.envFrom, undefined);
  assert.equal(
    manifest.spec!.template.metadata!.annotations!["everything.dev/release"],
    "4",
  );
});

test("an artifact with a disk runs as a StatefulSet mounting /data, with its database Secret", () => {
  const manifest = statefulSetManifest(
    workload({ diskGi: 2, database: true, healthPath: "/health" }),
    settings,
  );
  const container = manifest.spec!.template.spec!.containers[0]!;
  assert.equal(manifest.kind, "StatefulSet");
  assert.equal(manifest.spec!.replicas, 1);
  assert.ok(
    container.volumeMounts!.some((mount) => mount.mountPath === "/data"),
  );
  assert.deepEqual(container.envFrom, [
    {
      secretRef: { name: "artifact-6f1c1f6e8c7e4c4b9a432d8b8f7c8f11-database" },
    },
  ]);
  assert.equal(container.readinessProbe!.httpGet!.path, "/health");
});

test("capability environments use Secret references and cannot be shadowed by older saved variables", () => {
  const requested = workload({
    database: true,
    capabilities: ["everything-api", "api-key"],
    env: {
      MODE: "demo",
      EVERYTHING_CLIENT_SECRET: "old-value",
      APP_API_KEY: "old-key",
    },
  });
  const pod = deploymentManifest(
    {
      ...requested,
      capabilities: {
        secretNames: ["app-api-secret", "app-key-secret"],
        fingerprint: "credentials-v2",
      },
    },
    settings,
  ).spec!.template;
  assert.deepEqual(pod.spec!.containers[0]!.envFrom, [
    {
      secretRef: { name: "artifact-6f1c1f6e8c7e4c4b9a432d8b8f7c8f11-database" },
    },
    { secretRef: { name: "app-api-secret" } },
    { secretRef: { name: "app-key-secret" } },
  ]);
  assert.equal(
    pod.metadata!.annotations!["everything.dev/capabilities"],
    "credentials-v2",
  );
  assert.doesNotMatch(
    JSON.stringify(pod),
    /old-value|old-key|EVERYTHING_CLIENT_SECRET|APP_API_KEY/,
  );
});

test("database Secrets carry a URL and the standard libpq variables", () => {
  const connection: DatabaseConnection = {
    host: "postgres.everything.svc.cluster.local",
    port: 5432,
    database: "artifact_data",
    user: "artifact_x",
    password: "abc123",
  };
  const secret = databaseSecretManifest(artifactId, connection, settings);
  const decoded = Object.fromEntries(
    Object.entries(secret.data!).map(([key, value]) => [
      key,
      Buffer.from(value, "base64").toString(),
    ]),
  );
  assert.equal(
    decoded.DATABASE_URL,
    "postgresql://artifact_x:abc123@postgres.everything.svc.cluster.local:5432/artifact_data",
  );
  assert.equal(decoded.PGPASSWORD, "abc123");
  assert.equal(decoded.PGDATABASE, "artifact_data");
});

test("runtime status is running once a pod is ready and failing when a pod cannot start", () => {
  const pod = {
    phase: "Running",
    ready: false,
    restarts: 0,
    waitingReason: null,
  };
  assert.deepEqual(runtimeFromPods([]), {
    state: "starting",
    restarts: 0,
    reason: null,
  });
  assert.equal(
    runtimeFromPods([{ ...pod, ready: true, restarts: 2 }]).state,
    "running",
  );
  assert.deepEqual(
    runtimeFromPods([
      { ...pod, restarts: 3, waitingReason: "CrashLoopBackOff" },
    ]),
    { state: "failing", restarts: 3, reason: "CrashLoopBackOff" },
  );
  assert.deepEqual(
    runtimeFromPods([{ ...pod, waitingReason: "ContainerCreating" }]),
    {
      state: "starting",
      restarts: 0,
      reason: "ContainerCreating",
    },
  );
});

/** An orchestrator that records what the reconciler asks of it. */
function recordingOrchestrator(password?: string) {
  const calls: string[] = [];
  const applied: ArtifactWorkload[] = [];
  const orchestrator: WorkloadOrchestrator = {
    apply: async (requested) => void applied.push(requested),
    stop: async (id) => void calls.push(`stop:${id}`),
    remove: async (id) => void calls.push(`remove:${id}`),
    runtimes: async () => new Map<string, ArtifactRuntime>(),
    logs: async () => "",
    databasePassword: async () => password,
    writeDatabaseSecret: async (id, connection) =>
      void calls.push(`secret:${id}:${connection.password}`),
  };
  return { calls, applied, orchestrator };
}

test("reconciling runs the live deployment by digest, reusing the stored database password", async () => {
  const artifacts = new MemoryArtifacts();
  const deployments = new MemoryDeployments();
  const app = artifacts.add("dynamic", "app", {
    liveDeployment: 1,
    running: true,
    release: 1,
  });
  await deployments.create(
    { ownerId: owner, artifactId: app.id },
    {
      release: 1,
      author: ada,
      build: 3,
      imageDigest: "sha256:abc",
      port: 8080,
      env: {},
      database: true,
      capabilities: ["everything-api"],
      diskGi: null,
      healthPath: null,
    },
  );
  const { calls, applied, orchestrator } = recordingOrchestrator(
    "a".repeat(48),
  );
  const ensured: string[] = [];
  const capabilityCalls: unknown[] = [];
  const reconciler = new WorkloadReconciler(
    artifacts,
    deployments,
    orchestrator,
    {
      ensure: async (id, password) => {
        ensured.push(password);
        return {
          host: "db",
          port: 5432,
          database: "data",
          user: `role-${id}`,
          password,
        };
      },
      remove: async () => {},
    },
    "localhost:30500",
    {
      /** Capture app ownership and the stored capability request. */
      reconcile: async (owner, enabled) => {
        capabilityCalls.push([owner.id, owner.ownerId, enabled]);
        return {
          secretNames: ["app-api-secret"],
          fingerprint: "secret-version",
        };
      },
      remove: async (removed) => {
        capabilityCalls.push(["remove", removed.id, removed.ownerId]);
      },
    },
    new ArtifactLock(),
  );
  await reconciler.reconcile(app);
  assert.deepEqual(ensured, ["a".repeat(48)]);
  assert.equal(calls[0], `secret:${app.id}:${"a".repeat(48)}`);
  assert.match(
    applied[0]!.image,
    /^localhost:30500\/artifacts\/[0-9a-f]{32}@sha256:abc$/,
  );
  assert.equal(applied[0]!.databaseFingerprint?.length, 16);
  assert.deepEqual(capabilityCalls, [[app.id, owner, ["everything-api"]]]);
  assert.deepEqual(applied[0]!.capabilities, {
    secretNames: ["app-api-secret"],
    fingerprint: "secret-version",
  });

  const stopped = { ...app, running: false };
  await reconciler.reconcile(stopped);
  assert.equal(calls.at(-1), `stop:${app.id}`);
  await reconciler.reconcile(artifacts.add("static", "site"));
  assert.equal(applied.length, 1);
  assert.equal(capabilityCalls.length, 1);
  await reconciler.remove(app);
  assert.deepEqual(capabilityCalls.at(-1), ["remove", app.id, owner]);
});

test("background reconciliation rechecks existence under the shared lock before provisioning", async () => {
  const artifacts = new MemoryArtifacts();
  const app = artifacts.add("dynamic", "app");
  const reconciler = new WorkloadReconciler(
    { list: async () => [app], getById: async () => undefined },
    {
      findByRelease: async () =>
        assert.fail("deleted app must not be reconciled"),
    },
    recordingOrchestrator().orchestrator,
    { ensure: async () => assert.fail("no database"), remove: async () => {} },
    "registry",
    {
      reconcile: async () => assert.fail("no credentials"),
      remove: async () => {},
    },
    new ArtifactLock(),
  );
  await reconciler.reconcileAll();
});
