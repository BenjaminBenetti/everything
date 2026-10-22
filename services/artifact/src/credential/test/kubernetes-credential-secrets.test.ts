import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreV1Api, V1Secret } from "@kubernetes/client-node";
import { deploymentManifest } from "../../deployment/adapter/workload-manifests.js";
import { KubernetesCredentialSecrets } from "../adapter/kubernetes-credential-secrets.js";

const artifactId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const credentialId = "0b6f4d4e-2a1c-4f53-8f6e-3c0f3ad1d001";
const value = "  multi\nline $HOME `x` \\ 'q' \"dq\" ü 🔑\r\n ";

/** A core API holding Secrets in memory, answering like the API server. */
function fakeCore() {
  const secrets = new Map<string, V1Secret>();
  const calls: string[] = [];
  const conflict = () => Object.assign(new Error("exists"), { code: 409 });
  const missing = () => Object.assign(new Error("missing"), { code: 404 });
  const core = {
    createNamespacedSecret: async ({ body }: { body: V1Secret }) => {
      calls.push(`create:${body.metadata!.name}`);
      if (secrets.has(body.metadata!.name!)) throw conflict();
      secrets.set(body.metadata!.name!, structuredClone(body));
      return body;
    },
    readNamespacedSecret: async ({ name }: { name: string }) => {
      const secret = secrets.get(name);
      if (!secret) throw missing();
      return secret;
    },
    deleteNamespacedSecret: async ({ name }: { name: string }) => {
      calls.push(`delete:${name}`);
      if (!secrets.delete(name)) throw missing();
      return {};
    },
    listNamespacedSecret: async ({
      labelSelector,
    }: {
      labelSelector: string;
    }) => {
      calls.push(`list:${labelSelector}`);
      return { items: [...secrets.values()] };
    },
  } as unknown as CoreV1Api;
  return { core, secrets, calls };
}

test("each version is an immutable, labeled Secret whose bytes decode to exactly the value", async () => {
  const { core, secrets } = fakeCore();
  const store = new KubernetesCredentialSecrets({ core }, "apps");
  await store.write(artifactId, credentialId, 3, value);
  const [secret] = [...secrets.values()];
  assert.equal(
    secret!.metadata!.name,
    "artifact-6f1c1f6e8c7e4c4b9a432d8b8f7c8f11-credential-0b6f4d4e2a1c4f538f6e3c0f3ad1d001-v3",
  );
  assert.equal(secret!.immutable, true);
  assert.deepEqual(secret!.metadata!.labels, {
    "app.kubernetes.io/managed-by": "everything-artifact",
    "everything.dev/artifact-id": artifactId,
    "everything.dev/credential-id": credentialId,
    "everything.dev/credential-version": "3",
  });
  assert.equal(
    Buffer.from(secret!.data!.value!, "base64").toString("utf8"),
    value,
  );
  assert.equal(await store.read(secret!.metadata!.name!), value);
  assert.deepEqual(await store.stored(artifactId), [
    {
      artifactId,
      credentialId,
      version: 3,
      name: secret!.metadata!.name!,
    },
  ]);
});

test("rewriting an existing version keeps an identical copy and replaces a different one", async () => {
  const { core, secrets, calls } = fakeCore();
  const store = new KubernetesCredentialSecrets({ core }, "apps");
  await store.write(artifactId, credentialId, 1, value);
  await store.write(artifactId, credentialId, 1, value);
  assert.ok(!calls.some((call) => call.startsWith("delete:")));
  await store.write(artifactId, credentialId, 1, "different");
  assert.ok(calls.some((call) => call.startsWith("delete:")));
  const [secret] = [...secrets.values()];
  assert.equal(
    Buffer.from(secret!.data!.value!, "base64").toString(),
    "different",
  );
});

test("pruning deletes an app's other versions and tolerates copies already gone", async () => {
  const { core, secrets } = fakeCore();
  const store = new KubernetesCredentialSecrets({ core }, "apps");
  await store.write(artifactId, credentialId, 1, "one");
  await store.write(artifactId, credentialId, 2, "two");
  const keep = [...secrets.keys()].find((name) => name.endsWith("-v2"))!;
  await store.prune(artifactId, new Set([keep]));
  assert.deepEqual([...secrets.keys()], [keep]);
  await store.prune(artifactId, new Set());
  assert.equal(secrets.size, 0);
});

test("pods read credentials by reference to their version's Secret, never by value", () => {
  const manifest = deploymentManifest(
    {
      artifactId,
      slug: "app",
      image: "registry/app@sha256:abc",
      settings: {
        port: 8080,
        env: { MODE: "demo", SHADOW: "plain" },
        database: false,
        capabilities: [],
        diskGi: null,
        healthPath: null,
      },
      release: 2,
      databaseFingerprint: null,
      capabilities: { secretNames: [], fingerprint: null },
      credentials: [
        { env: "TOKEN", credentialId, version: 4 },
        { env: "PORT", credentialId, version: 4 },
        { env: "PGPASSWORD", credentialId, version: 4 },
        { env: "SHADOW", credentialId, version: 4 },
      ],
    },
    { namespace: "apps", pullSecret: "pull", storageClassName: "" },
  );
  const template = manifest.spec!.template;
  const env = template.spec!.containers[0]!.env!;
  assert.deepEqual(
    env.map((variable) => variable.name),
    ["MODE", "SHADOW", "TOKEN", "PORT", "BASE_PATH"],
  );
  assert.deepEqual(env[2], {
    name: "TOKEN",
    valueFrom: {
      secretKeyRef: {
        name: "artifact-6f1c1f6e8c7e4c4b9a432d8b8f7c8f11-credential-0b6f4d4e2a1c4f538f6e3c0f3ad1d001-v4",
        key: "value",
      },
    },
  });
  assert.equal(
    template.metadata!.annotations!["everything.dev/credentials"],
    `TOKEN=${credentialId}@4`,
  );
});
