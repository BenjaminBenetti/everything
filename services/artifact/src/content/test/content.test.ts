import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { extract } from "tar-stream";
import { artifactLimits } from "@everything/artifact-contracts";
import { validateManifest } from "../model/manifest.js";
import { archiveSource } from "../service/source-archive.js";
import { FileContentStore } from "../service/file-content-store.js";

/** The SHA-256 of some text. */
function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A content store in a temporary directory, removed after the test. */
async function store(context: {
  after: (cleanup: () => Promise<void>) => void;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-content-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return new FileContentStore(root);
}

/** Read a stream into text. */
async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

test("manifests are sorted by path and refuse unsafe paths, duplicates, and oversized content", () => {
  const entry = (filePath: string, size = 1) => ({
    path: filePath,
    sha256: hashOf(filePath),
    size,
    executable: false,
  });
  const manifest = validateManifest([entry("b.txt", 2), entry("a/c.txt", 3)]);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["a/c.txt", "b.txt"],
  );
  assert.equal(manifest.totalSize, 5);
  for (const unsafe of [
    "/etc/passwd",
    "../x",
    "a/../b",
    "a//b",
    "./a",
    "a\\b",
    "dir/",
  ])
    assert.throws(
      () => validateManifest([entry(unsafe)]),
      { code: "INVALID_FILES" },
      unsafe,
    );
  assert.throws(() => validateManifest([]), { code: "INVALID_FILES" });
  assert.throws(
    () => validateManifest([entry("a"), entry("a")]),
    /more than once/,
  );
  assert.throws(
    () => validateManifest([entry("big", artifactLimits.fileSize + 1)]),
    { code: "INVALID_FILES" },
  );
  assert.throws(
    () =>
      validateManifest(
        Array.from({ length: 9 }, (_, index) =>
          entry(`f${index}`, artifactLimits.fileSize),
        ),
      ),
    /total at most/,
  );
});

test("content is stored only under the hash of its bytes", async (context) => {
  const content = await store(context);
  const hash = hashOf("hello");
  assert.deepEqual(await content.missing([hash, hash]), [hash]);
  await assert.rejects(
    content.write(hashOf("other"), Readable.from(["hello"]), 100),
    {
      code: "CONTENT_MISMATCH",
    },
  );
  await content.write(hash, Readable.from(["hel", "lo"]), 100);
  assert.deepEqual(await content.missing([hash]), []);
  assert.equal(await text(await content.open(hash)), "hello");
  await content.write(hash, Readable.from(["hello"]), 100);
  await assert.rejects(content.open(hashOf("absent")), {
    code: "CONTENT_NOT_FOUND",
  });
  await assert.rejects(content.open("../../etc/passwd"), {
    code: "CONTENT_NOT_FOUND",
  });
});

test("uploads larger than the limit are refused without storing anything", async (context) => {
  const content = await store(context);
  const hash = hashOf("too large");
  await assert.rejects(content.write(hash, Readable.from(["too large"]), 4), {
    code: "CONTENT_TOO_LARGE",
  });
  assert.deepEqual(await content.missing([hash]), [hash]);
});

test("build sources are archived with their paths, content, and executable bits", async (context) => {
  const content = await store(context);
  const files = [
    { path: "Dockerfile", body: "FROM scratch\n", executable: false },
    { path: "bin/start.sh", body: "#!/bin/sh\n", executable: true },
  ];
  for (const file of files)
    await content.write(hashOf(file.body), Readable.from([file.body]), 100);
  const archive = archiveSource(
    files.map((file) => ({
      path: file.path,
      sha256: hashOf(file.body),
      size: file.body.length,
      executable: file.executable,
    })),
    content,
  );
  const entries: { name: string; mode: number; body: string }[] = [];
  const reader = extract();
  reader.on("entry", (header, stream, next) => {
    void text(stream as unknown as Readable).then((body) => {
      entries.push({ name: header.name, mode: header.mode ?? 0, body });
      next();
    });
  });
  await new Promise<void>((resolve, reject) => {
    reader.on("finish", resolve);
    reader.on("error", reject);
    archive.pipe(reader);
  });
  assert.deepEqual(entries, [
    { name: "Dockerfile", mode: 0o644, body: "FROM scratch\n" },
    { name: "bin/start.sh", mode: 0o755, body: "#!/bin/sh\n" },
  ]);
});
