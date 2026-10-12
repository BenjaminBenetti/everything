import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import {
  ada,
  file,
  MemoryArtifacts,
  MemoryBuilds,
  MemoryDeployments,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import type { Artifact } from "../../artifact/model/artifact.js";
import { DeploymentService } from "../service/deployment-service.js";

const digest = `sha256:${"a".repeat(64)}`;

/** A deployment service over in-memory storage that records reconciled artifacts. */
async function fixture() {
  const artifacts = new MemoryArtifacts();
  const builds = new MemoryBuilds();
  const deployments = new MemoryDeployments();
  const reconciled: Artifact[] = [];
  const app = artifacts.add("dynamic", "app");
  const scope = { ownerId: owner, artifactId: app.id };
  const build = await builds.create(scope, {
    number: 1,
    author: ada,
    dockerfile: "Dockerfile",
    buildArgs: {},
    files: [file("Dockerfile")],
    totalSize: 10,
    sourceTokenHash: "token",
  });
  await builds.record(scope, build.id, {
    status: "succeeded",
    imageDigest: digest,
  });
  const service = new DeploymentService(
    artifacts,
    deployments,
    builds,
    { reconcile: async (artifact) => void reconciled.push(artifact) },
    { logs: async () => "output" },
    new ArtifactLookup(artifacts),
    new ArtifactLock(),
  );
  return { app, artifacts, builds, deployments, reconciled, scope, service };
}

test("a first deployment uses the defaults, runs the latest successful build, and is reconciled", async () => {
  const { deployments, reconciled, scope, service } = await fixture();
  const deployed = await service.deploy(owner, ada, "app", {});
  assert.equal(deployed.release, 1);
  assert.equal(deployed.liveDeployment, 1);
  assert.equal(deployed.running, true);
  const deployment = await deployments.findByRelease(scope, 1);
  assert.equal(deployment?.build, 1);
  assert.equal(deployment?.imageDigest, digest);
  assert.equal(deployment?.port, 8080);
  assert.equal(deployment?.database, false);
  assert.equal(deployment?.diskGi, null);
  assert.equal(reconciled.length, 1);
});

test("later deployments keep omitted settings and replace given ones", async () => {
  const { deployments, scope, service } = await fixture();
  await service.deploy(owner, ada, "app", {
    port: 3000,
    env: { MODE: "demo" },
    database: true,
    diskGi: 2,
    healthPath: "/health",
  });
  await service.deploy(owner, ada, "app", {
    env: { MODE: "live" },
    healthPath: null,
  });
  const second = await deployments.findByRelease(scope, 2);
  assert.equal(second?.port, 3000);
  assert.deepEqual(second?.env, { MODE: "live" });
  assert.equal(second?.database, true);
  assert.equal(second?.diskGi, 2);
  assert.equal(second?.healthPath, null);
});

test("a disk keeps the size it was created with", async () => {
  const { artifacts, app, service } = await fixture();
  await service.deploy(owner, ada, "app", { diskGi: 2 });
  await assert.rejects(service.deploy(owner, ada, "app", { diskGi: 5 }), {
    code: "DISK_SIZE_FIXED",
  });
  const withoutDisk = await service.deploy(owner, ada, "app", { diskGi: null });
  assert.equal(withoutDisk.diskGi, 2);
  assert.equal(
    (await artifacts.getById({ ownerId: owner }, app.id))?.diskGi,
    2,
  );
});

test("deployments refuse reserved variables, unfinished builds, and stale releases", async () => {
  const { service } = await fixture();
  await assert.rejects(
    service.deploy(owner, ada, "app", { env: { PORT: "1" } }),
    {
      code: "RESERVED_VARIABLE",
    },
  );
  await assert.rejects(service.deploy(owner, ada, "app", { build: 7 }), {
    code: "BUILD_NOT_READY",
  });
  await service.deploy(owner, ada, "app", {});
  await assert.rejects(service.deploy(owner, ada, "app", { basedOn: 0 }), {
    code: "RELEASE_CONFLICT",
  });
});

test("stopping keeps the deployment and reconciles the artifact as stopped", async () => {
  const { reconciled, service } = await fixture();
  await service.deploy(owner, ada, "app", {});
  const stopped = await service.stop(owner, ada, "app");
  assert.equal(stopped.running, false);
  assert.equal(stopped.liveDeployment, 1);
  assert.equal(reconciled.at(-1)?.running, false);
});

test("static artifacts cannot be deployed", async () => {
  const { artifacts, service } = await fixture();
  artifacts.add("static", "site");
  await assert.rejects(service.deploy(owner, ada, "site", {}), {
    code: "WRONG_ARTIFACT_KIND",
  });
});
