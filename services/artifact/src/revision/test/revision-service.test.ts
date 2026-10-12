import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import {
  ada,
  file,
  grace,
  MemoryArtifacts,
  MemoryRevisions,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import { RevisionService } from "../service/revision-service.js";

/** A revision service over in-memory storage, with every uploaded hash present unless listed missing. */
function fixture(missing: string[] = []) {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const service = new RevisionService(
    artifacts,
    revisions,
    {
      missing: async (hashes) =>
        hashes.filter((hash) => missing.includes(hash)),
    },
    new ArtifactLookup(artifacts),
    new ArtifactLock(),
  );
  return { artifacts, revisions, service };
}

test("publishing stores a sorted revision and makes it the next live release", async () => {
  const { artifacts, revisions, service } = fixture();
  const site = artifacts.add("static", "site");
  const published = await service.publish(owner, ada, "site", {
    files: [file("index.html"), file("assets/app.js", 20, true)],
  });
  assert.equal(published.release, 1);
  assert.equal(published.liveRevision, 1);
  assert.deepEqual(published.updatedBy, ada);
  const stored = await revisions.findByNumber(
    { ownerId: owner, artifactId: site.id },
    1,
  );
  assert.deepEqual(
    stored?.files.map((entry) => entry.path),
    ["assets/app.js", "index.html"],
  );
  assert.equal(stored?.totalSize, 30);
  const second = await service.publish(owner, grace, site.id, {
    files: [file("index.html")],
  });
  assert.equal(second.release, 2);
  assert.equal(second.liveRevision, 2);
});

test("a change based on an older release is refused and names the newer release's author", async () => {
  const { artifacts, service } = fixture();
  artifacts.add("static", "site");
  await service.publish(owner, grace, "site", { files: [file("index.html")] });
  await assert.rejects(
    service.publish(owner, ada, "site", {
      files: [file("index.html")],
      basedOn: 0,
    }),
    { code: "RELEASE_CONFLICT", message: /Release 1 by Grace/ },
  );
  const current = await service.publish(owner, ada, "site", {
    files: [file("index.html")],
    basedOn: 1,
  });
  assert.equal(current.release, 2);
});

test("publishing requires uploaded content, valid paths, and a static artifact", async () => {
  const missing = file("missing.html");
  const { artifacts, service } = fixture([missing.sha256]);
  artifacts.add("static", "site");
  artifacts.add("dynamic", "app");
  await assert.rejects(
    service.publish(owner, ada, "site", { files: [missing] }),
    {
      code: "CONTENT_MISSING",
    },
  );
  await assert.rejects(
    service.publish(owner, ada, "site", { files: [file("../escape.html")] }),
    { code: "INVALID_FILES" },
  );
  await assert.rejects(
    service.publish(owner, ada, "site", {
      files: [file("a.html"), file("a.html")],
    }),
    { code: "INVALID_FILES" },
  );
  await assert.rejects(
    service.publish(owner, ada, "app", { files: [file("index.html")] }),
    {
      code: "WRONG_ARTIFACT_KIND",
    },
  );
  await assert.rejects(
    service.publish("someone-else", ada, "site", { files: [file("a")] }),
    {
      code: "ARTIFACT_NOT_FOUND",
    },
  );
});

test("an earlier revision can be made live again as a new release", async () => {
  const { artifacts, service } = fixture();
  artifacts.add("static", "site");
  await service.publish(owner, ada, "site", { files: [file("v1.html")] });
  await service.publish(owner, ada, "site", { files: [file("v2.html")] });
  const rolledBack = await service.activate(owner, grace, "site", 1, {
    basedOn: 2,
  });
  assert.equal(rolledBack.liveRevision, 1);
  assert.equal(rolledBack.release, 3);
  await assert.rejects(service.activate(owner, ada, "site", 9, {}), {
    code: "REVISION_NOT_FOUND",
  });
});
