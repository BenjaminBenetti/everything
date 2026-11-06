import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { extract } from "tar-stream";
import {
  artifactLimits,
  formatByteLimit,
} from "@everything/artifact-contracts";
import { requireStoredContent, validateManifest } from "../model/manifest.js";
import { archiveSource } from "../service/source-archive.js";
import { FileContentStore } from "../service/file-content-store.js";
import { repeated, repeatedHash } from "./content-fixture.js";

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
  return Object.assign(new FileContentStore(root), { directory: root });
}

/** A file entry of `size` bytes whose hash is derived from its path. */
function sized(filePath: string, size: number) {
  return { path: filePath, sha256: hashOf(filePath), size, executable: false };
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
});

test("app sources take files up to 100 MiB and up to 1 GiB in all, counting every listed path", () => {
  const MiB = 1024 * 1024;
  assert.deepEqual(
    [artifactLimits.fileSize, artifactLimits.totalSize],
    [104_857_600, 1_073_741_824],
  );
  assert.deepEqual(
    [
      formatByteLimit(artifactLimits.fileSize),
      formatByteLimit(artifactLimits.totalSize),
    ],
    ["100 MiB", "1 GiB"],
  );
  // Sizes the old 25 MiB and 200 MiB limits refused.
  assert.equal(
    validateManifest([sized("old-max.bin", 25 * MiB + 1)]).totalSize,
    25 * MiB + 1,
  );
  assert.equal(
    validateManifest([sized("max.bin", 100 * MiB)]).totalSize,
    100 * MiB,
  );
  assert.throws(() => validateManifest([sized("over.bin", 100 * MiB + 1)]), {
    code: "INVALID_FILES",
    message: '"over.bin" is larger than 100 MiB.',
  });
  // Ten 100 MiB files and 24 MiB more make exactly 1 GiB; a byte more is refused.
  const full = [
    ...Array.from({ length: 10 }, (_, index) =>
      sized(`part-${index}.bin`, 100 * MiB),
    ),
    sized("rest.bin", 24 * MiB),
  ];
  assert.equal(validateManifest(full).totalSize, 1024 * MiB);
  assert.throws(() => validateManifest([...full, sized("byte.txt", 1)]), {
    code: "INVALID_FILES",
    message: "Files can total at most 1 GiB.",
  });
  // The same content at eleven paths counts eleven times.
  const shared = sized("shared.bin", 100 * MiB);
  assert.throws(
    () =>
      validateManifest(
        Array.from({ length: 11 }, (_, index) => ({
          ...shared,
          path: `copy-${index}.bin`,
        })),
      ),
    { message: "Files can total at most 1 GiB." },
  );
});

test("listed files must be stored, at the size they are listed with", () => {
  const manifest = validateManifest([
    sized("a.bin", 5),
    { ...sized("a.bin", 5), path: "b.bin" },
    sized("c.bin", 7),
  ]);
  const stored = new Map([
    [hashOf("a.bin"), 5],
    [hashOf("c.bin"), 7],
  ]);
  requireStoredContent(manifest, stored);
  assert.throws(
    () => requireStoredContent(manifest, new Map([[hashOf("c.bin"), 7]])),
    { code: "CONTENT_MISSING", message: /^1 file has not been uploaded/ },
  );
  assert.throws(() => requireStoredContent(manifest, new Map()), {
    code: "CONTENT_MISSING",
    message: /^2 files have not been uploaded/,
  });
  for (const size of [4, 6])
    assert.throws(
      () =>
        requireStoredContent(
          manifest,
          new Map([...stored, [hashOf("a.bin"), size]]),
        ),
      {
        code: "INVALID_FILES",
        message: `"a.bin" is listed as 5 bytes, but its uploaded content is ${size} bytes.`,
      },
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

test("the store keeps a file of exactly 100 MiB and refuses one byte more, counting the bytes it receives", async (context) => {
  const content = await store(context);
  const limit = artifactLimits.fileSize;
  const exact = repeatedHash(limit);
  await content.write(exact, repeated(limit), limit);
  assert.deepEqual(
    await content.sizes([exact, exact]),
    new Map([[exact, limit]]),
  );
  assert.equal(
    (
      await stat(
        path.join(content.directory, "content", exact.slice(0, 2), exact),
      )
    ).size,
    limit,
  );
  // One byte more is refused whether or not its hash is already stored.
  const over = repeatedHash(limit + 1);
  for (const hash of [over, exact])
    await assert.rejects(content.write(hash, repeated(limit + 1), limit), {
      code: "CONTENT_TOO_LARGE",
      message: "Files can be at most 100 MiB.",
    });
  assert.deepEqual(await content.missing([over, exact]), [over]);
  // Short or altered content never reaches its address, and no partial upload is left behind.
  for (const body of [repeated(limit - 1), repeated(limit, 1)])
    await assert.rejects(content.write(over, body, limit), {
      code: "CONTENT_MISMATCH",
    });
  assert.deepEqual(await content.missing([over]), [over]);
  assert.deepEqual(await readdir(path.join(content.directory, "incoming")), []);
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
