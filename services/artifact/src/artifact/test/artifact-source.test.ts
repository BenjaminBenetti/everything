import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactLock } from "../service/artifact-lock.js";
import { ArtifactLookup } from "../service/artifact-lookup.js";
import { ArtifactService } from "../service/artifact-service.js";
import type { Artifact } from "../model/artifact.js";
import {
  MemoryArtifacts,
  MemoryBuilds,
  MemoryDeployments,
  MemoryRevisions,
  ada,
  file,
  owner,
} from "./artifact-fixture.js";

/** The artifact service over in-memory records, with helpers that add revisions, builds, and releases. */
function fixture() {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const builds = new MemoryBuilds();
  const deployments = new MemoryDeployments();
  const lookup = new ArtifactLookup(artifacts);
  const service = new ArtifactService(
    artifacts,
    revisions,
    builds,
    deployments,
    { runtimes: async () => new Map() },
    {
      builds: { cancel: async () => {} },
      workloads: { remove: async () => {} },
    },
    lookup,
    new ArtifactLock(),
    {
      artifact: "http://artifacts.test",
      publicApps: "http://public.apps.test",
    },
    { states: async () => new Map() },
  );
  const scope = (artifact: Artifact) => ({
    ownerId: owner,
    artifactId: artifact.id,
  });
  return {
    artifacts,
    service,
    /** Add revision `number`, whose one file is named for it. */
    revision: (artifact: Artifact, number: number) =>
      revisions.create(scope(artifact), {
        number,
        author: ada,
        files: [file(`revision-${number}.html`)],
        totalSize: 10,
      }),
    /** Add build `number`, whose one file is named for it. */
    build: (artifact: Artifact, number: number) =>
      builds.create(scope(artifact), {
        number,
        author: ada,
        dockerfile: "Dockerfile",
        buildArgs: {},
        files: [file(`build-${number}`)],
        totalSize: 10,
        sourceTokenHash: `${artifact.slug}-${number}`,
      }),
    /** Record release `release` deploying build `build`. */
    deploy: (artifact: Artifact, release: number, build: number) =>
      deployments.create(scope(artifact), {
        release,
        author: ada,
        build,
        imageDigest: `sha256:${"0".repeat(64)}`,
        port: 8080,
        env: {},
        database: false,
        capabilities: [],
        diskGi: null,
        healthPath: null,
      }),
  };
}

test("checking out a dynamic app copies its live build by default, even after a newer build, or the newest build before any release", async () => {
  const { artifacts, service, build, deploy } = fixture();
  const game = artifacts.add("dynamic", "game", {
    release: 4,
    liveDeployment: 4,
  });
  await build(game, 1);
  await deploy(game, 4, 1);
  await build(game, 2);
  assert.deepEqual(await service.source(owner, "game", {}), {
    origin: "build",
    number: 1,
    // The release to pass as basedOn, which is not the build's number.
    release: 4,
    files: [file("build-1")],
  });
  const chosen = await service.source(owner, "game", { build: 2 });
  assert.deepEqual([chosen.number, chosen.release], [2, 4]);
  await assert.rejects(service.source(owner, "game", { revision: 1 }), {
    code: "REVISION_NOT_FOUND",
  });
  await assert.rejects(service.source(owner, "game", { build: 3 }), {
    code: "BUILD_NOT_FOUND",
  });
  const draft = artifacts.add("dynamic", "draft");
  await assert.rejects(service.source(owner, "draft", {}), {
    code: "SOURCE_NOT_FOUND",
  });
  await build(draft, 1);
  await build(draft, 2);
  const newest = await service.source(owner, "draft", {});
  assert.deepEqual([newest.number, newest.release], [2, 0]);
});

test("checking out a static app copies its live revision by default, and its own revisions only", async () => {
  const { artifacts, service, revision } = fixture();
  const page = artifacts.add("static", "page", {
    release: 3,
    liveRevision: 1,
  });
  await revision(page, 1);
  await revision(page, 2);
  assert.deepEqual(await service.source(owner, "page", {}), {
    origin: "revision",
    number: 1,
    release: 3,
    files: [file("revision-1.html")],
  });
  const chosen = await service.source(owner, "page", { revision: 2 });
  assert.deepEqual([chosen.number, chosen.release], [2, 3]);
  await assert.rejects(service.source(owner, "page", { build: 1 }), {
    code: "BUILD_NOT_FOUND",
  });
  await assert.rejects(service.source("other-owner", "page", {}), {
    code: "ARTIFACT_NOT_FOUND",
  });
  artifacts.add("static", "unpublished");
  await assert.rejects(service.source(owner, "unpublished", {}), {
    code: "SOURCE_NOT_FOUND",
  });
});
