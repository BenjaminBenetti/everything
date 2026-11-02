import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import sharp from "sharp";
import { PngWebpEncoder } from "../adapter/png-webp-encoder.js";
import { WorkspaceAttachmentFiles } from "../adapter/workspace-attachment-files.js";
import type { AttachmentImageEncoder } from "../interface/attachment-image-encoder.js";
import {
  attachmentPath,
  attachmentStagingFolder,
  classifyAttachment,
  webpName,
} from "../model/attachment-file.js";
import { AttachmentService } from "../service/attachment-service.js";
import { AttachmentExpiry } from "../service/attachment-expiry.js";
import {
  AttachmentCompleteError,
  AttachmentNotFoundError,
  AttachmentStorageError,
  AttachmentLimitError,
} from "../error/attachment-errors.js";
import {
  agentId,
  otherAgentId,
  agents,
  ownerId,
  chunks,
  MemoryAttachments,
  workspaceVolume,
} from "./attachment-fixtures.js";
import { screenshot, animatedPng } from "./synthetic-screenshot.js";

async function fixture(t: TestContext, encoder?: AttachmentImageEncoder) {
  const volume = await workspaceVolume(t);
  const files = encoder
    ? new WorkspaceAttachmentFiles(volume.root, volume.workspaces, encoder)
    : volume.files;
  const records = new MemoryAttachments();
  const service = new AttachmentService(agents, records, files);
  const upload = async (name: string, input: Buffer) => {
    const pending = await service.create(ownerId, agentId, {
      name,
      size: input.length,
    });
    return service.append(ownerId, agentId, pending.id, 0, chunks(input));
  };
  return {
    volume,
    files,
    records,
    service,
    upload,
    staging: path.join(volume.root, attachmentStagingFolder),
  };
}

test("content, not extension, controls real conversion; APNG/non-PNG/no-benefit bytes remain exact", async (t) => {
  const f = await fixture(t);
  const input = await screenshot(320, 180);
  const converted = await f.upload("actually-an-image.txt", input);
  assert.equal(converted.name, "actually-an-image.webp");
  assert.equal(converted.mediaType, "image/webp");
  assert.ok(converted.size < input.length);
  const jpeg = await sharp(input).jpeg().toBuffer();
  const webp = await sharp(input).webp().toBuffer();
  const tiny = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 31, g: 91, b: 151, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const malformed = Buffer.from(input);
  malformed[29] = malformed[29]! ^ 1;
  for (const [name, bytes] of [
    ["fake.png", Buffer.from("plain text")],
    ["photo.jpg", jpeg],
    ["existing.webp", webp],
    ["animated.png", animatedPng()],
    ["small.png", tiny],
    ["broken.png", malformed],
    ["data.bin", Buffer.from([0, 255, 1, 128])],
    [
      "tiny.gif",
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    ],
  ] as const) {
    const saved = await f.upload(name, bytes);
    assert.equal(saved.name, name);
    assert.equal(saved.size, bytes.length);
    assert.equal(saved.received, bytes.length);
    assert.deepEqual(await readFile(f.volume.local(saved.path)), bytes);
    assert.deepEqual(await readdir(path.dirname(f.volume.local(saved.path))), [
      path.basename(saved.path),
    ]);
  }
  assert.deepEqual(await readdir(f.staging), []);
});

test("concurrent final-part retry serializes one real encode and one publication", async (t) => {
  let calls = 0;
  const real = new PngWebpEncoder();
  const f = await fixture(t, {
    webp: (...args) => {
      calls++;
      return real.webp(...args);
    },
  });
  const input = await screenshot(320, 180);
  const pending = await f.service.create(ownerId, agentId, {
    name: "one.png",
    size: input.length,
  });
  const outcomes = await Promise.allSettled([
    f.service.append(ownerId, agentId, pending.id, 0, chunks(input)),
    f.service.append(ownerId, agentId, pending.id, 0, chunks(input)),
  ]);
  assert.equal(calls, 1);
  assert.equal(outcomes[0]!.status, "fulfilled");
  assert.ok(
    outcomes[1]!.status === "rejected" &&
      outcomes[1]!.reason instanceof AttachmentCompleteError,
  );
  const ready = await f.records.getById({ ownerId, agentId }, pending.id);
  assert.equal(ready?.mediaType, "image/webp");
  assert.deepEqual(await readdir(path.dirname(f.volume.local(ready!.path))), [
    "one.webp",
  ]);
  assert.deepEqual(await readdir(f.staging), []);
});

test("an aborted final encode rewinds original bytes/offset; retry then converts without re-uploading earlier parts", async (t) => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const real = new PngWebpEncoder();
  let hold = true;
  const f = await fixture(t, {
    async webp(bytes, signal) {
      if (hold) {
        entered();
        await new Promise((_, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
      }
      return real.webp(bytes, signal);
    },
  });
  const input = await screenshot(640, 360);
  const pending = await f.service.create(ownerId, agentId, {
    name: "resume.png",
    size: input.length,
  });
  const offset = Math.floor(input.length / 2);
  await f.service.append(
    ownerId,
    agentId,
    pending.id,
    0,
    chunks(input.subarray(0, offset)),
  );
  const abort = new AbortController();
  const final = f.service.append(
    ownerId,
    agentId,
    pending.id,
    offset,
    chunks(input.subarray(offset)),
    abort.signal,
  );
  const rejected = assert.rejects(final, { name: "AbortError" });
  await waiting;
  abort.abort();
  await rejected;
  assert.equal(
    (await f.records.getById({ ownerId, agentId }, pending.id))!.received,
    offset,
  );
  assert.deepEqual(
    await readFile(path.join(f.staging, pending.id + ".part")),
    input.subarray(0, offset),
  );
  assert.deepEqual(await readdir(f.staging), [pending.id + ".part"]);
  hold = false;
  const ready = await f.service.append(
    ownerId,
    agentId,
    pending.id,
    offset,
    chunks(input.subarray(offset)),
  );
  assert.equal(ready.received, input.length);
  assert.ok(ready.size < input.length);
  assert.deepEqual(await readdir(f.staging), []);
});

test("prepared/published crash recovery marks the actual WebP ready without another encode; expiry removes its canonical path", async (t) => {
  let calls = 0;
  const real = new PngWebpEncoder();
  const f = await fixture(t, {
    webp: (...args) => {
      calls++;
      return real.webp(...args);
    },
  });
  const input = await screenshot(320, 180);
  const stage = async (name: string) => {
    const pending = await f.service.create(ownerId, agentId, {
      name,
      size: input.length,
    });
    await f.files.append(pending.id, 0, chunks(input), input.length);
    const prepared = await f.files.prepare(
      { agentId, id: pending.id, fileName: name },
      input.length,
    );
    const canonical = {
      name: webpName(name),
      size: prepared.size,
      path: attachmentPath(prepared.location),
      ...classifyAttachment(prepared.head),
    };
    await f.records.prepare({ ownerId, agentId }, pending.id, canonical);
    await f.files.publish(prepared.location, prepared.encoded);
    return { pending, canonical };
  };
  const first = await stage("interrupted.png");
  const recovered = await f.service.append(
    ownerId,
    agentId,
    first.pending.id,
    input.length,
    chunks(),
  );
  assert.equal(calls, 1);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.path, first.canonical.path);
  assert.equal(recovered.size, first.canonical.size);
  const second = await stage("expired.png");
  f.records.age(second.pending.id, "2026-01-01T00:00:00Z");
  // Keep the first unsent ready file recent while the interrupted upload is expired.
  f.records.age(first.pending.id, "2026-11-02T00:00:00Z");
  await new AttachmentExpiry(f.records, f.files, () =>
    Date.parse("2026-11-02T00:01:00Z"),
  ).expire();
  await assert.rejects(readFile(f.volume.local(second.canonical.path)), {
    code: "ENOENT",
  });
  assert.equal(
    await f.records.getById({ ownerId, agentId }, second.pending.id),
    undefined,
  );
  assert.deepEqual(await readdir(f.staging), []);
});

test("completion failure removes encoded publication and all staging; pre-existing targets are not overwritten", async (t) => {
  const f = await fixture(t);
  const input = await screenshot(320, 180);
  t.mock.method(f.records, "complete", async () => {
    throw new Error("Synthetic database failure");
  });
  await assert.rejects(
    f.upload("failure.png", input),
    /Synthetic database failure/,
  );
  assert.equal(f.records.rows.size, 0);
  assert.deepEqual(
    await readdir(path.join(f.volume.workspace(agentId), "attachments")),
    [],
  );
  assert.deepEqual(await readdir(f.staging), []);
  const pending = await f.service.create(ownerId, agentId, {
    name: "collision.png",
    size: input.length,
  });
  const target = path.join(
    f.volume.workspace(agentId),
    "attachments",
    pending.id,
  );
  await writeFile(target, "pre-existing");
  await assert.rejects(
    f.service.append(ownerId, agentId, pending.id, 0, chunks(input)),
    AttachmentStorageError,
  );
  assert.equal(await readFile(target, "utf8"), "pre-existing");
  assert.deepEqual(await readdir(f.staging), []);
});

test("symlinked final folders and partial files never redirect a conversion to another workspace", async (t) => {
  const f = await fixture(t);
  const input = await screenshot(320, 180);
  const foreign = f.volume.workspace(otherAgentId);
  await mkdir(foreign, { recursive: true });
  await writeFile(path.join(foreign, "keep.txt"), "keep");
  const pending = await f.service.create(ownerId, agentId, {
    name: "private.png",
    size: input.length,
  });
  await mkdir(path.join(f.volume.workspace(agentId), "attachments"), {
    recursive: true,
  });
  await symlink(
    foreign,
    path.join(f.volume.workspace(agentId), "attachments", pending.id),
  );
  await assert.rejects(
    f.service.append(ownerId, agentId, pending.id, 0, chunks(input)),
    AttachmentStorageError,
  );
  assert.deepEqual(await readdir(foreign), ["keep.txt"]);
  assert.deepEqual(await readdir(f.staging), []);
  const second = await f.service.create(ownerId, agentId, {
    name: "source.png",
    size: input.length,
  });
  await rmPartial(path.join(f.staging, second.id + ".part"));
  await symlink(
    path.join(foreign, "keep.txt"),
    path.join(f.staging, second.id + ".part"),
  );
  await assert.rejects(
    f.service.append(ownerId, agentId, second.id, 0, chunks(input)),
    AttachmentNotFoundError,
  );
  await f.service.remove(ownerId, agentId, second.id);
  assert.equal(await readFile(path.join(foreign, "keep.txt"), "utf8"), "keep");
});

/** Unlink only the one test-owned partial when setting up the no-follow case. */
async function rmPartial(file: string) {
  const { unlink } = await import("node:fs/promises");
  await unlink(file);
}

test("completed compression does not release the original-byte batch reservation", async (t) => {
  const f = await fixture(t);
  const input = await screenshot(320, 180);
  const ready = await f.upload("quota.png", input);
  const stored = f.records.rows.get(ready.id)!;
  // Domain accounting setup: retain actual encoded metadata but fill the 100MiB original reservation.
  for (let index = 0; index < 4; index++) {
    const id = "reserved-" + index;
    f.records.rows.set(id, {
      ...stored,
      id,
      inputSize: 25 * 1024 * 1024,
      received: 25 * 1024 * 1024,
    });
  }
  await assert.rejects(
    f.service.create(ownerId, agentId, { name: "one-more", size: 1 }),
    AttachmentLimitError,
  );
});

test("expiry during a real encode removes the reservation and any subsequently created candidate", async (t) => {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = new PngWebpEncoder();
  const f = await fixture(t, {
    async webp(...args) {
      entered();
      await held;
      return real.webp(...args);
    },
  });
  const input = await screenshot(320, 180);
  const pending = await f.service.create(ownerId, agentId, {
    name: "expires.png",
    size: input.length,
  });
  const uploading = f.service.append(
    ownerId,
    agentId,
    pending.id,
    0,
    chunks(input),
  );
  const rejected = assert.rejects(uploading, AttachmentNotFoundError);
  await waiting;
  f.records.age(pending.id, "2026-01-01T00:00:00Z");
  await new AttachmentExpiry(f.records, f.files, () =>
    Date.parse("2026-11-02T00:01:00Z"),
  ).expire();
  release();
  await rejected;
  assert.equal(f.records.rows.size, 0);
  assert.deepEqual(await readdir(f.staging), []);
  await assert.rejects(
    readdir(path.join(f.volume.workspace(agentId), "attachments")),
    { code: "ENOENT" },
  );
});

test("removal queued during conversion waits for one real publication then removes its canonical file", async (t) => {
  let entered!: () => void,
    release!: () => void,
    calls = 0;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = new PngWebpEncoder();
  const f = await fixture(t, {
    async webp(...args) {
      calls++;
      entered();
      await held;
      return real.webp(...args);
    },
  });
  const input = await screenshot(320, 180);
  const pending = await f.service.create(ownerId, agentId, {
    name: "cancel.png",
    size: input.length,
  });
  const uploading = f.service.append(
    ownerId,
    agentId,
    pending.id,
    0,
    chunks(input),
  );
  await waiting;
  const removing = f.service.remove(ownerId, agentId, pending.id);
  release();
  const ready = await uploading;
  await removing;
  assert.equal(calls, 1);
  assert.equal(ready.mediaType, "image/webp");
  assert.equal(f.records.rows.size, 0);
  assert.deepEqual(await readdir(f.staging), []);
  assert.deepEqual(
    await readdir(path.join(f.volume.workspace(agentId), "attachments")),
    [],
  );
});

test("a recovered publication is cleaned up if the final database transition fails", async (t) => {
  const f = await fixture(t);
  const input = await screenshot(320, 180);
  const pending = await f.service.create(ownerId, agentId, {
    name: "recovered.png",
    size: input.length,
  });
  await f.files.append(pending.id, 0, chunks(input), input.length);
  const prepared = await f.files.prepare(
    { agentId, id: pending.id, fileName: "recovered.png" },
    input.length,
  );
  await f.records.prepare({ ownerId, agentId }, pending.id, {
    name: "recovered.webp",
    size: prepared.size,
    path: attachmentPath(prepared.location),
    ...classifyAttachment(prepared.head),
  });
  await f.files.publish(prepared.location, prepared.encoded);
  t.mock.method(f.records, "complete", async () => {
    throw new Error("Synthetic recovery failure");
  });
  await assert.rejects(
    f.service.append(ownerId, agentId, pending.id, input.length, chunks()),
    /Synthetic recovery failure/,
  );
  assert.equal(f.records.rows.size, 0);
  assert.deepEqual(await readdir(f.staging), []);
  assert.deepEqual(
    await readdir(path.join(f.volume.workspace(agentId), "attachments")),
    [],
  );
});

test("legacy in-flight and ready uploads retain their original format, path, bytes and size", async (t) => {
  let calls = 0;
  const real = new PngWebpEncoder();
  const f = await fixture(t, {
    webp: (...args) => {
      calls++;
      return real.webp(...args);
    },
  });
  const input = await screenshot(320, 180);
  const pending = await f.service.create(ownerId, agentId, {
    name: "legacy.png",
    size: input.length,
  });
  // The new migration marks all pre-existing reservations false; HTTP clients cannot choose this flag.
  f.records.rows.set(pending.id, {
    ...f.records.rows.get(pending.id)!,
    encodePng: false,
  });
  const ready = await f.service.append(
    ownerId,
    agentId,
    pending.id,
    0,
    chunks(input),
  );
  assert.equal(calls, 0);
  assert.equal(ready.name, "legacy.png");
  assert.equal(ready.path, pending.path);
  assert.equal(ready.size, input.length);
  assert.equal(ready.mediaType, "image/png");
  assert.deepEqual(await readFile(f.volume.local(ready.path)), input);
  const content = await f.service.content(ownerId, agentId, ready.id);
  const pieces: Buffer[] = [];
  for await (const piece of content.stream) pieces.push(piece as Buffer);
  assert.deepEqual(Buffer.concat(pieces), input);
  assert.equal(calls, 0);
});
