import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ada,
  MemoryArtifacts,
  MemoryDeployments,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import { ProvisionedClientSecrets } from "../adapter/provisioned-client-secrets.js";
import { AppResponseBlockedError } from "../error/app-response-blocked-error.js";

test("response protection reads only the app's own provisioned secret and observes rotation", async () => {
  const artifacts = new MemoryArtifacts();
  const deployments = new MemoryDeployments();
  const first = artifacts.add("dynamic", "first", { liveDeployment: 1 });
  const second = artifacts.add("dynamic", "second", { liveDeployment: 1 });
  for (const artifact of [first, second]) {
    await deployments.create(
      { ownerId: owner, artifactId: artifact.id },
      {
        release: 1,
        author: ada,
        build: 1,
        imageDigest: "sha256:fixture",
        database: false,
        env: {},
        capabilities: ["everything-api"],
        port: 3000,
        diskGi: null,
        healthPath: null,
      },
    );
  }
  const environments = new Map([
    [first.id, { EVERYTHING_CLIENT_SECRET: "first-secret" }],
    [second.id, { EVERYTHING_CLIENT_SECRET: "second-secret" }],
  ]);
  const reader = new ProvisionedClientSecrets(deployments, {
    /** Enforce a capability-specific lookup rather than listing cluster credentials. */
    read: async (id, capability) => {
      assert.equal(capability, "everything-api");
      return environments.get(id);
    },
  });
  assert.deepEqual(await reader.read(first), ["first-secret"]);
  assert.deepEqual(await reader.read(second), ["second-secret"]);
  environments.set(first.id, { EVERYTHING_CLIENT_SECRET: "rotated-secret" });
  assert.deepEqual(await reader.read(first), ["rotated-secret"]);
  environments.delete(first.id);
  await assert.rejects(reader.read(first), AppResponseBlockedError);
  environments.set(first.id, { EVERYTHING_CLIENT_SECRET: "" });
  await assert.rejects(reader.read(first), AppResponseBlockedError);
  await assert.rejects(
    reader.read({ ...second, ownerId: "other-owner" }),
    AppResponseBlockedError,
  );
});

test("missing credentials are permitted only for an existing deployment without the capability", async () => {
  const deployments = new MemoryDeployments();
  const artifact = new MemoryArtifacts().add("dynamic", "plain", {
    liveDeployment: 1,
  });
  let environment: Record<string, string> | undefined;
  const reader = new ProvisionedClientSecrets(deployments, {
    read: async () => environment,
  });
  await assert.rejects(reader.read(artifact), AppResponseBlockedError);
  await deployments.create(
    { ownerId: owner, artifactId: artifact.id },
    {
      release: 1,
      author: ada,
      build: 1,
      imageDigest: "sha256:fixture",
      database: false,
      env: {},
      capabilities: [],
      port: 3000,
      diskGi: null,
      healthPath: null,
    },
  );
  assert.deepEqual(await reader.read(artifact), []);
  environment = {
    EVERYTHING_CLIENT_SECRET: "provisioned-before-release-is-written",
  };
  assert.deepEqual(await reader.read(artifact), [
    environment.EVERYTHING_CLIENT_SECRET,
  ]);
  environment = {};
  await assert.rejects(reader.read(artifact), AppResponseBlockedError);
  const unavailable = new ProvisionedClientSecrets(deployments, {
    read: async () => {
      throw new Error("adapter error with sensitive details");
    },
  });
  await assert.rejects(unavailable.read(artifact), (error: unknown) => {
    assert.ok(error instanceof AppResponseBlockedError);
    assert.ok(!error.message.includes("sensitive details"));
    return true;
  });
});
