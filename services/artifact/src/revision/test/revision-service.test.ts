import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactLimits } from "@everything/artifact-contracts";
import { ArtifactLock } from "../../artifact/service/artifact-lock.js";
import { ArtifactLookup } from "../../artifact/service/artifact-lookup.js";
import {
  ada,
  file,
  grace,
  MemoryArtifacts,
  MemoryContent,
  MemoryRevisions,
  owner,
} from "../../artifact/test/artifact-fixture.js";
import { RevisionService } from "../service/revision-service.js";

/** A revision service over in-memory storage, with the given files' content uploaded. */
function fixture(...uploaded: ReturnType<typeof file>[]) {
  const artifacts = new MemoryArtifacts();
  const revisions = new MemoryRevisions();
  const content = new MemoryContent().add(...uploaded);
  const service = new RevisionService(
    artifacts,
    revisions,
    content,
    new ArtifactLookup(artifacts),
    new ArtifactLock(),
  );
  return { artifacts, content, revisions, service };
}

test("publishing stores a sorted revision and makes it the next live release", async () => {
  const { artifacts, revisions, service } = fixture(
    file("index.html"),
    file("assets/app.js", 20, true),
  );
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
  const { artifacts, service } = fixture(file("index.html"));
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
  const { artifacts, service } = fixture();
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
  const { artifacts, service } = fixture(file("v1.html"), file("v2.html"));
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

test("a revision's limits count every listed path at its uploaded size: 100 MiB per file and 1 GiB in all", async () => {
  // Content store sizes are in-memory metadata here; the HTTP and file store tests move real bytes.
  const large = file("large.bin", artifactLimits.fileSize);
  const rest = file("rest.bin", artifactLimits.totalSize - 10 * large.size);
  const extra = file("extra.txt", 1);
  const { artifacts, revisions, service } = fixture(large, rest, extra);
  const site = artifacts.add("static", "site");
  // One 100 MiB upload listed at ten paths, and the remaining 24 MiB, total exactly 1 GiB.
  const copies = Array.from({ length: 10 }, (_, index) => ({
    ...large,
    path: `copy-${index}/large.bin`,
  }));
  const published = await service.publish(owner, ada, "site", {
    files: [...copies, rest],
  });
  assert.equal(published.release, 1);
  const stored = await revisions.findByNumber(
    { ownerId: owner, artifactId: site.id },
    1,
  );
  assert.deepEqual(
    [stored?.fileCount, stored?.totalSize],
    [11, 1024 * 1024 * 1024],
  );
  // A single byte more is refused, and so is an eleventh path sharing the same content.
  for (const files of [
    [...copies, rest, extra],
    [...copies, { ...large, path: "copy-10/large.bin" }],
  ])
    await assert.rejects(service.publish(owner, ada, "site", { files }), {
      code: "INVALID_FILES",
      message: "Files can total at most 1 GiB.",
    });
  // Listing content smaller or larger than it was uploaded can't get past the limits either.
  for (const size of [1, large.size + 1])
    await assert.rejects(
      service.publish(owner, ada, "site", {
        files: [{ ...large, size }],
      }),
      {
        code: "INVALID_FILES",
        message:
          size > artifactLimits.fileSize
            ? '"large.bin" is larger than 100 MiB.'
            : `"large.bin" is listed as 1 byte, but its uploaded content is ${large.size} bytes.`,
      },
    );
  assert.equal(
    await revisions.latestNumber({ ownerId: owner, artifactId: site.id }),
    1,
  );
});
