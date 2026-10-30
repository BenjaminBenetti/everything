import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import {
  AttachmentOffsetError,
  AttachmentStorageError,
  AttachmentTooLargeError,
} from "../error/attachment-errors.js";
import {
  attachmentFolder,
  attachmentStagingFolder,
} from "../model/attachment-file.js";
import {
  agentId,
  binaryBytes,
  chunks,
  otherAgentId,
  pngBytes,
  workspaceVolume,
} from "./attachment-fixtures.js";

/** A location with a fresh ID in the main teammate's workspace. */
function location(fileName = "notes.txt") {
  return { agentId, id: randomUUID(), fileName };
}

test("files keep their exact bytes from parts to their path in the teammate's workspace", async (context) => {
  const volume = await workspaceVolume(context);
  const cases = [
    ["notes.txt", [Buffer.from("héllo "), Buffer.from("wörld\n")]],
    ["picture.png", [pngBytes.subarray(0, 10), pngBytes.subarray(10)]],
    ["data.bin", [binaryBytes.subarray(0, 5), binaryBytes.subarray(5)]],
    ["empty.txt", []],
  ] as const;
  for (const [fileName, parts] of cases) {
    const target = location(fileName);
    await volume.files.begin(target.id);
    let offset = 0;
    for (const part of parts)
      offset += await volume.files.append(
        target.id,
        offset,
        chunks(part),
        1024,
      );
    await volume.files.publish(target);
    const expected = Buffer.concat(parts);
    const saved = path.join(
      volume.workspace(agentId),
      attachmentFolder,
      target.id,
      fileName,
    );
    assert.deepEqual(await readFile(saved), expected, fileName);
    assert.equal((await stat(saved)).mode & 0o777, 0o644);
    const opened = await volume.files.open(target);
    assert.equal(opened?.size, expected.length);
    const streamed: Buffer[] = [];
    for await (const chunk of opened!.stream) streamed.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(streamed), expected);
  }
  // Partial files are gone once published, and they never lived inside a teammate's workspace.
  assert.deepEqual(
    await readdir(path.join(volume.root, attachmentStagingFolder)),
    [],
  );
});

test("a part over its limit, a disconnect, or a wrong offset leaves only the bytes saved before it", async (context) => {
  const volume = await workspaceVolume(context);
  const target = location();
  await volume.files.begin(target.id);
  const partial = path.join(
    volume.root,
    attachmentStagingFolder,
    `${target.id}.part`,
  );
  assert.equal(
    await volume.files.append(target.id, 0, chunks(Buffer.from("abc")), 3),
    3,
  );
  await assert.rejects(
    volume.files.append(
      target.id,
      3,
      chunks(Buffer.from("de"), Buffer.from("fgh")),
      4,
    ),
    AttachmentTooLargeError,
  );
  assert.equal((await readFile(partial)).toString(), "abc");
  /** A request body that fails after some bytes, as a dropped connection does. */
  async function* dropped() {
    yield Buffer.from("de");
    throw new Error("aborted");
  }
  await assert.rejects(
    volume.files.append(target.id, 3, dropped(), 100),
    /aborted/,
  );
  assert.equal((await readFile(partial)).toString(), "abc");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    volume.files.append(
      target.id,
      3,
      chunks(Buffer.from("x")),
      100,
      cancelled.signal,
    ),
  );
  assert.equal((await readFile(partial)).toString(), "abc");
  await assert.rejects(
    volume.files.append(target.id, 1, chunks(Buffer.from("x")), 100),
    AttachmentOffsetError,
  );
  await volume.files.discard(target.id);
  await assert.rejects(lstat(partial), { code: "ENOENT" });
});

test("links in the teammate's workspace never redirect a published file elsewhere", async (context) => {
  const volume = await workspaceVolume(context);
  const victim = volume.workspace(otherAgentId);
  await mkdir(victim, { recursive: true });
  await mkdir(volume.workspace(agentId), { recursive: true });
  // The teammate points its attachments folder at another teammate's workspace.
  await symlink(victim, path.join(volume.workspace(agentId), attachmentFolder));
  const target = location("payload.txt");
  await volume.files.begin(target.id);
  await volume.files.append(target.id, 0, chunks(Buffer.from("data")), 10);
  await assert.rejects(volume.files.publish(target), AttachmentStorageError);
  assert.deepEqual(await readdir(victim), []);

  // A link named for the attachment inside a real attachments folder is refused too.
  const linked = await workspaceVolume(context);
  const folder = path.join(linked.workspace(agentId), attachmentFolder);
  await mkdir(folder, { recursive: true });
  const other = linked.workspace(otherAgentId);
  await mkdir(other, { recursive: true });
  const named = location("payload.txt");
  await symlink(other, path.join(folder, named.id));
  await linked.files.begin(named.id);
  await linked.files.append(named.id, 0, chunks(Buffer.from("data")), 10);
  await assert.rejects(linked.files.publish(named), AttachmentStorageError);
  assert.deepEqual(await readdir(other), []);
});

test("reading and removing never follow links the teammate placed", async (context) => {
  const volume = await workspaceVolume(context);
  const secret = path.join(volume.workspace(otherAgentId), "secret.txt");
  await mkdir(path.dirname(secret), { recursive: true });
  await writeFile(secret, "other teammate's secret");
  const target = location("notes.txt");
  await volume.files.begin(target.id);
  await volume.files.append(target.id, 0, chunks(Buffer.from("mine")), 10);
  await volume.files.publish(target);
  const saved = path.join(
    volume.workspace(agentId),
    attachmentFolder,
    target.id,
    "notes.txt",
  );
  // The teammate replaces its attachment with a link to a file it can't see.
  await rm(saved);
  await symlink(secret, saved);
  assert.equal(await volume.files.open(target), undefined);
  await volume.files.remove(target);
  assert.equal(await readFile(secret, "utf8"), "other teammate's secret");

  // With the whole attachments folder pointing elsewhere, removal leaves the other files alone.
  const redirected = await workspaceVolume(context);
  const victimFolder = path.join(redirected.workspace(otherAgentId), "x");
  const id = randomUUID();
  await mkdir(path.join(victimFolder, id), { recursive: true });
  await writeFile(path.join(victimFolder, id, "notes.txt"), "keep");
  await mkdir(redirected.workspace(agentId), { recursive: true });
  await symlink(
    victimFolder,
    path.join(redirected.workspace(agentId), attachmentFolder),
  );
  await redirected.files.remove({ agentId, id, fileName: "notes.txt" });
  assert.equal(
    await readFile(path.join(victimFolder, id, "notes.txt"), "utf8"),
    "keep",
  );
  assert.equal(
    await redirected.files.open({ agentId, id, fileName: "notes.txt" }),
    undefined,
  );
});

test("removal deletes a published file and its folder", async (context) => {
  const volume = await workspaceVolume(context);
  const target = location("report.csv");
  await volume.files.begin(target.id);
  await volume.files.append(target.id, 0, chunks(Buffer.from("a,b\n")), 10);
  await volume.files.publish(target);
  await volume.files.remove(target);
  assert.deepEqual(
    await readdir(path.join(volume.workspace(agentId), attachmentFolder)),
    [],
  );
  await volume.files.remove(target);
  assert.equal(await volume.files.open(target), undefined);
});

test("only partial files untouched since the cutoff are reported for cleanup", async (context) => {
  const volume = await workspaceVolume(context);
  const stale = randomUUID();
  const fresh = randomUUID();
  await volume.files.begin(stale);
  await volume.files.begin(fresh);
  const old = new Date("2026-01-01T00:00:00Z");
  await utimes(
    path.join(volume.root, attachmentStagingFolder, `${stale}.part`),
    old,
    old,
  );
  await writeFile(
    path.join(volume.root, attachmentStagingFolder, "not-an-upload"),
    "",
  );
  assert.deepEqual(
    await volume.files.partials(Date.parse("2026-06-01T00:00:00Z")),
    [stale],
  );
  await assert.rejects(volume.files.discard("../escape"));
});

test("the stream of an opened file reads what is there now", async (context) => {
  const volume = await workspaceVolume(context);
  const target = location("notes.txt");
  await volume.files.begin(target.id);
  await volume.files.append(target.id, 0, chunks(Buffer.from("v1")), 10);
  await volume.files.publish(target);
  await writeFile(
    path.join(
      volume.workspace(agentId),
      attachmentFolder,
      target.id,
      "notes.txt",
    ),
    "changed by the teammate",
  );
  const opened = await volume.files.open(target);
  assert.equal(await text(opened!.stream), "changed by the teammate");
});
