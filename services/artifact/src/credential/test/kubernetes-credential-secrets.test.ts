import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreV1Api, V1Secret } from "@kubernetes/client-node";
import { deploymentManifest } from "../../deployment/adapter/workload-manifests.js";
import { KubernetesCredentialSecrets } from "../adapter/kubernetes-credential-secrets.js";

const artifactId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const credentialId = "0b6f4d4e-2a1c-4f53-8f6e-3c0f3ad1d001";
const value = "  multi\nline $HOME `x` \\ 'q' \"dq\" ü 🔑\r\n ";
const valueId = "9c0b7a52-6d0e-4f0d-9a77-0f2a3f1f6c01";
const otherValueId = "9c0b7a52-6d0e-4f0d-9a77-0f2a3f1f6c02";

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
  await store.write(artifactId, credentialId, 3, valueId, value);
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
    "everything.dev/credential-value": valueId,
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
      valueId,
      name: secret!.metadata!.name!,
    },
  ]);
});

test("a version is never stored with a second value; a copy changed by hand is restored", async () => {
  const { core, secrets, calls } = fakeCore();
  const store = new KubernetesCredentialSecrets({ core }, "apps");
  await store.write(artifactId, credentialId, 1, valueId, value);
  await store.write(artifactId, credentialId, 1, valueId, value);
  assert.ok(!calls.some((call) => call.startsWith("delete:")));
  await assert.rejects(
    store.write(artifactId, credentialId, 1, otherValueId, "different"),
    { code: "CREDENTIAL_VALUE_CONFLICT" },
  );
  const [kept] = [...secrets.values()];
  assert.equal(Buffer.from(kept!.data!.value!, "base64").toString(), value);
  kept!.data!.value = Buffer.from("changed by hand").toString("base64");
  await store.write(artifactId, credentialId, 1, valueId, value);
  assert.ok(calls.some((call) => call.startsWith("delete:")));
  const [restored] = [...secrets.values()];
  assert.equal(Buffer.from(restored!.data!.value!, "base64").toString(), value);
});

test("pruning deletes an app's other versions and tolerates copies already gone", async () => {
  const { core, secrets } = fakeCore();
  const store = new KubernetesCredentialSecrets({ core }, "apps");
  await store.write(artifactId, credentialId, 1, valueId, "one");
  await store.write(artifactId, credentialId, 2, otherValueId, "two");
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
