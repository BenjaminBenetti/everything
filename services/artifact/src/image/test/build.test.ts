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
import { buildJobManifest } from "../adapter/build-job-manifest.js";
import type {
  BuildJob,
  BuildProgress,
  BuildRunner,
} from "../interface/build-runner.js";
import { BuildService } from "../service/build-service.js";

const job: BuildJob = {
  buildId: "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11",
  artifactId: "7f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f12",
  dockerfile: "docker/app.Dockerfile",
  buildArgs: { VERSION: "1.2" },
  sourceUrl: "http://artifact:8081/internal/v1/build-sources/x?token=t",
  image: "registry:5000/artifacts/x:build-3",
};

test("build jobs download their source, build the named Dockerfile, and push without retrying", () => {
  const manifest = buildJobManifest(job, {
    namespace: "builds",
    image: "moby/buildkit:v0.33.1-rootless",
    pushSecret: "registry-push",
  });
  const pod = manifest.spec!.template.spec!;
  const args = pod.containers[0]!.args!;
  assert.equal(manifest.spec!.backoffLimit, 0);
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.ok(args.includes("--local=dockerfile=/source/context/docker"));
  assert.ok(args.includes("--opt=filename=app.Dockerfile"));
  assert.ok(args.includes("--opt=build-arg:VERSION=1.2"));
  assert.ok(
    args.includes(
      `--output=type=image,name=${job.image},push=true,registry.insecure=true`,
    ),
  );
  assert.deepEqual(pod.initContainers![0]!.env, [
    { name: "SOURCE_URL", value: job.sourceUrl },
  ]);
  assert.equal(
    pod.containers[0]!.securityContext!.seccompProfile!.type,
    "Unconfined",
  );
});

/** A build service over in-memory storage and a scripted runner. */
function fixture(phases: BuildProgress[] = []) {
  const artifacts = new MemoryArtifacts();
  const builds = new MemoryBuilds();
  const started: BuildJob[] = [];
  const removed: string[] = [];
  const runner: BuildRunner = {
    start: async (requested) => void started.push(requested),
    progress: async () => phases.shift() ?? { phase: "pending", reason: null },
    log: async () => "build output",
    remove: async (id) => void removed.push(id),
  };
  const service = new BuildService(
    builds,
    new MemoryDeployments(),
    { missing: async () => [] },
    runner,
    {
      digest: async (repository, tag) =>
        `sha256:${repository.length}${tag}`.padEnd(71, "0"),
    },
    new ArtifactLookup(artifacts),
    new ArtifactLock(),
    { sourceUrl: "http://artifact:8081", pushHost: "registry:5000" },
  );
  return { artifacts, builds, removed, service, started };
}

test("a build is recorded, started with a source token, and its source served only to that token", async () => {
  const { artifacts, service, started } = fixture();
  const app = artifacts.add("dynamic", "app");
  const build = await service.start(owner, ada, "app", {
    files: [file("Dockerfile"), file("server.js")],
    dockerfile: "Dockerfile",
    buildArgs: {},
  });
  assert.deepEqual(
    [build.number, build.status, build.fileCount],
    [1, "queued", 2],
  );
  const request = started[0]!;
  const compactId = app.id.replaceAll("-", "");
  assert.equal(request.image, `registry:5000/artifacts/${compactId}:build-1`);
  const token = new URL(request.sourceUrl).searchParams.get("token")!;
  assert.equal((await service.source(request.buildId, token))?.length, 2);
  assert.equal(await service.source(request.buildId, "wrong"), undefined);
});

test("builds need a Dockerfile in their source and a dynamic artifact", async () => {
  const { artifacts, service } = fixture();
  artifacts.add("dynamic", "app");
  artifacts.add("static", "site");
  await assert.rejects(
    service.start(owner, ada, "app", {
      files: [file("server.js")],
      dockerfile: "Dockerfile",
      buildArgs: {},
    }),
    { code: "DOCKERFILE_MISSING" },
  );
  await assert.rejects(
    service.start(owner, ada, "site", {
      files: [file("Dockerfile")],
      dockerfile: "Dockerfile",
      buildArgs: {},
    }),
    { code: "WRONG_ARTIFACT_KIND" },
  );
});

test("monitoring records running, succeeded, and failed builds with their logs", async () => {
  const { artifacts, builds, removed, service } = fixture([
    { phase: "running", reason: null },
    { phase: "succeeded", reason: null },
    { phase: "failed", reason: "The build failed. Read its log for details." },
  ]);
  artifacts.add("dynamic", "app");
  const input = {
    files: [file("Dockerfile")],
    dockerfile: "Dockerfile",
    buildArgs: {},
  };
  await service.start(owner, ada, "app", input);
  await service.monitor();
  assert.equal(builds.records[0]!.status, "running");
  await service.monitor();
  assert.equal(builds.records[0]!.status, "succeeded");
  assert.match(builds.records[0]!.imageDigest!, /^sha256:/);
  assert.equal(builds.records[0]!.log, "build output");
  assert.deepEqual(removed, [builds.records[0]!.id]);
  await service.start(owner, ada, "app", input);
  await service.monitor();
  assert.equal(builds.records[1]!.status, "failed");
  assert.match(builds.records[1]!.error!, /Read its log/);
  const details = await service.get(owner, "app", 2);
  assert.equal(details.log, "build output");
});
