import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultDeploymentSettings } from "@everything/artifact-contracts";
import { ArtifactService } from "../service/artifact-service.js";
import { ArtifactLookup } from "../service/artifact-lookup.js";
import { ArtifactLock } from "../service/artifact-lock.js";
import {
  ada,
  grace,
  owner,
  MemoryArtifacts,
  MemoryBuilds,
  MemoryDeployments,
  MemoryRevisions,
} from "./artifact-fixture.js";

test("summaries expose only public capability flags from the owner's current deployment, even while stopped", async () => {
  const artifacts = new MemoryArtifacts();
  const deployments = new MemoryDeployments();
  const service = new ArtifactService(
    artifacts,
    new MemoryRevisions(),
    new MemoryBuilds(),
    deployments,
    { runtimes: async () => new Map() },
    {
      builds: { cancel: async () => {} },
      workloads: { remove: async () => {} },
    },
    new ArtifactLookup(artifacts),
    new ArtifactLock(),
    { artifact: "http://apps.test", publicApps: "http://public.apps.test" },
  );
  const app = artifacts.add("dynamic", "planner", {
    liveDeployment: 2,
    release: 2,
    updatedBy: grace,
  });
  artifacts.add("static", "report", { liveRevision: 1 });
  artifacts.add("dynamic", "draft");
  artifacts.add("dynamic", "foreign", {
    ownerId: "other-owner",
    liveDeployment: 2,
  });
  const scope = { ownerId: owner, artifactId: app.id };
  // A colliding release belonging to another owner must not supply capabilities.
  await deployments.create(
    { ...scope, ownerId: "other-owner" },
    {
      ...defaultDeploymentSettings,
      release: 2,
      build: 1,
      imageDigest: `sha256:${"a".repeat(64)}`,
      author: grace,
    },
  );
  await deployments.create(scope, {
    ...defaultDeploymentSettings,
    release: 2,
    build: 1,
    imageDigest: `sha256:${"a".repeat(64)}`,
    author: ada,
    database: true,
    capabilities: ["everything-api"],
    env: { PRIVATE_VALUE: "not-public" },
  });
  await deployments.create(scope, {
    ...defaultDeploymentSettings,
    release: 3,
    build: 1,
    imageDigest: `sha256:${"a".repeat(64)}`,
    author: grace,
  });

  const list = await service.list(owner);
  assert.equal(list.length, 3);
  const summary = list.find((item) => item.id === app.id)!;
  assert.equal(summary.status, "stopped");
  assert.equal(summary.database, true);
  assert.deepEqual(summary.capabilities, ["everything-api"]);
  assert.deepEqual(summary.createdBy, ada);
  assert.deepEqual(summary.updatedBy, grace);
  assert.ok(!JSON.stringify(list).includes("not-public"));
  assert.equal("env" in summary, false);
  assert.equal("deployment" in summary, false);
  for (const item of list.filter((item) => item.id !== app.id)) {
    assert.equal(item.database, false);
    assert.deepEqual(item.capabilities, []);
  }
  const details = await service.details(owner, app.id);
  assert.equal(details.database, summary.database);
  assert.deepEqual(details.capabilities, summary.capabilities);

  await artifacts.update({ ownerId: owner }, app.id, {
    liveDeployment: 3,
    release: 3,
    updatedBy: grace,
  });
  const changed = (await service.list(owner)).find(
    (item) => item.id === app.id,
  )!;
  assert.equal(changed.database, false);
  assert.deepEqual(changed.capabilities, []);
});
