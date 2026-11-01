import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { test, type TestContext } from "node:test";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import {
  AttachmentCompleteError,
  AttachmentInUseError,
  AttachmentLimitError,
  AttachmentNotFoundError,
  AttachmentOffsetError,
  AttachmentStorageError,
  AttachmentTooLargeError,
} from "../error/attachment-errors.js";
import { attachmentLimits } from "../model/attachment.js";
import {
  attachmentFolder,
  attachmentStagingFolder,
} from "../model/attachment-file.js";
import { AttachmentService } from "../service/attachment-service.js";
import {
  agentId,
  agents,
  binaryBytes,
  chunks,
  MemoryAttachments,
  otherAgentId,
  ownerId,
  pngBytes,
  strangerAgentId,
  workspaceVolume,
} from "./attachment-fixtures.js";

/** A service over in-memory records and a real temporary workspace volume. */
async function fixture(context: TestContext) {
  const volume = await workspaceVolume(context);
  const records = new MemoryAttachments();
  const service = new AttachmentService(agents, records, volume.files);
  /** Upload a whole file in parts of at most `part` bytes. */
  async function upload(name: string, bytes: Buffer, part = bytes.length || 1) {
    let upload = await service.create(ownerId, agentId, {
      name,
      size: bytes.length,
    });
    for (let offset = 0; offset < bytes.length; offset += part)
      upload = await service.append(
        ownerId,
        agentId,
        upload.id,
        offset,
        chunks(bytes.subarray(offset, offset + part)),
      );
    return upload;
  }
  return { volume, records, service, upload };
}

test("uploads in parts land at a server-chosen path in the teammate's workspace with exact bytes and kinds", async (context) => {
  const { volume, upload } = await fixture(context);
  const text = Buffer.from("name,amount\nAda,3\n");
  const files = [
    ["Quarterly report.csv", text, "text", "text/plain"],
    ["photo.png", pngBytes, "image", "image/png"],
    ["firmware.bin", binaryBytes, "binary", "application/octet-stream"],
  ] as const;
  for (const [name, bytes, kind, mediaType] of files) {
    const result = await upload(name, bytes, 4);
    assert.equal(result.status, "ready");
    assert.equal(result.received, bytes.length);
    assert.equal(result.kind, kind);
    assert.equal(result.mediaType, mediaType);
    assert.equal(result.name, name);
    assert.match(
      result.path,
      new RegExp(
        `^/workspace/${agentId}/attachments/${result.id}/[A-Za-z0-9][A-Za-z0-9._-]*$`,
      ),
    );
    assert.deepEqual(await readFile(volume.local(result.path)), bytes);
  }
  assert.equal(
    (await upload("Quarterly report.csv", text)).path.endsWith(
      "/Quarterly_report.csv",
    ),
    true,
  );
});

test("an empty file is complete as soon as it is created", async (context) => {
  const { volume, service } = await fixture(context);
  const empty = await service.create(ownerId, agentId, {
    name: "empty.txt",
    size: 0,
  });
  assert.equal(empty.status, "ready");
  assert.equal(empty.kind, "text");
  assert.equal((await readFile(volume.local(empty.path))).length, 0);
});

test("files with the same name get separate folders, and hostile names stay inside them", async (context) => {
  const { volume, upload } = await fixture(context);
  const first = await upload("notes.txt", Buffer.from("first"));
  const second = await upload("notes.txt", Buffer.from("second"));
  assert.notEqual(first.path, second.path);
  assert.equal(await readFile(volume.local(first.path), "utf8"), "first");
  assert.equal(await readFile(volume.local(second.path), "utf8"), "second");
  for (const name of [
    "../../.bashrc",
    "AGENTS.md",
    ".pi/settings.json",
    "C:\\fakepath\\evil.sh",
    "/workspace/shared/x",
  ]) {
    const result = await upload(name, Buffer.from("echo pwned"));
    assert.ok(
      result.path.startsWith(`/workspace/${agentId}/attachments/${result.id}/`),
      name,
    );
  }
  // Nothing was written at the workspace's root, in its private state, or in the shared folder.
  assert.deepEqual(await readdir(volume.workspace(agentId)), [
    attachmentFolder,
  ]);
  assert.deepEqual(await readdir(volume.workspaces.shared), []);
});

test("limits count unsent files and their combined size per teammate", async (context) => {
  const { service, records } = await fixture(context);
  const created = [];
  for (let index = 0; index < attachmentLimits.maxFiles; index++)
    created.push(
      await service.create(ownerId, agentId, {
        name: `file-${index}.txt`,
        size: 1,
      }),
    );
  await assert.rejects(
    service.create(ownerId, agentId, { name: "one-more.txt", size: 1 }),
    (error) =>
      error instanceof AttachmentLimitError &&
      /up to 10 files/.test(error.message),
  );
  // Another teammate has its own allowance.
  await service.create(ownerId, otherAgentId, { name: "other.txt", size: 1 });
  // Sent files no longer count.
  records.claim(
    created.map((item) => item.id),
    randomUUID(),
  );
  await service.create(ownerId, agentId, {
    name: "big-1.bin",
    size: attachmentLimits.maxFileBytes,
  });
  await service.create(ownerId, agentId, {
    name: "big-2.bin",
    size: attachmentLimits.maxFileBytes,
  });
  await service.create(ownerId, agentId, {
    name: "big-3.bin",
    size: attachmentLimits.maxFileBytes,
  });
  await service.create(ownerId, agentId, {
    name: "big-4.bin",
    size: attachmentLimits.maxFileBytes,
  });
  await assert.rejects(
    service.create(ownerId, agentId, { name: "one-byte.txt", size: 1 }),
    (error) =>
      error instanceof AttachmentLimitError && /100 MB/.test(error.message),
  );
});

test("parts must continue the saved upload, fit its size, and stop once it is complete", async (context) => {
  const { service, volume } = await fixture(context);
  const upload = await service.create(ownerId, agentId, {
    name: "notes.txt",
    size: 4,
  });
  await assert.rejects(
    service.append(ownerId, agentId, upload.id, 2, chunks(Buffer.from("ab"))),
    AttachmentOffsetError,
  );
  await assert.rejects(
    service.append(
      ownerId,
      agentId,
      upload.id,
      0,
      chunks(Buffer.from("abcde")),
    ),
    AttachmentTooLargeError,
  );
  const half = await service.append(
    ownerId,
    agentId,
    upload.id,
    0,
    chunks(Buffer.from("ab")),
  );
  assert.equal(half.received, 2);
  assert.equal(half.status, "uploading");
  const done = await service.append(
    ownerId,
    agentId,
    upload.id,
    2,
    chunks(Buffer.from("cd")),
  );
  assert.equal(done.status, "ready");
  await assert.rejects(
    service.append(ownerId, agentId, upload.id, 4, chunks(Buffer.from("e"))),
    AttachmentCompleteError,
  );
  assert.equal(await readFile(volume.local(done.path), "utf8"), "abcd");
});

test("other owners, other teammates, and forged IDs all see the same missing attachment", async (context) => {
  const { service, upload } = await fixture(context);
  const mine = await upload("private.txt", Buffer.from("secret"));
  const forged = randomUUID();
  const attempts: [string, string, string][] = [
    ["stranger", agentId, mine.id],
    [ownerId, otherAgentId, mine.id],
    [ownerId, agentId, forged],
  ];
  for (const [owner, teammate, id] of attempts) {
    const expected =
      owner === ownerId ? AttachmentNotFoundError : AgentNotFoundError;
    await assert.rejects(service.content(owner, teammate, id), expected);
    await assert.rejects(
      service.append(owner, teammate, id, 0, chunks(Buffer.from("x"))),
      expected,
    );
    if (owner === ownerId)
      // Removal of a missing attachment has no effect, like the repository default.
      await service.remove(owner, teammate, id);
    else await assert.rejects(service.remove(owner, teammate, id), expected);
  }
  await assert.rejects(
    service.create(ownerId, strangerAgentId, { name: "x.txt", size: 1 }),
    AgentNotFoundError,
  );
  await assert.rejects(service.unsent("stranger", agentId), AgentNotFoundError);
  assert.equal(
    (
      await buffer((await service.content(ownerId, agentId, mine.id)).stream)
    ).toString(),
    "secret",
  );
});

test("removing cancels an upload or deletes an unsent file, but sent files stay with their message", async (context) => {
  const { service, records, volume, upload } = await fixture(context);
  const partial = await service.create(ownerId, agentId, {
    name: "big.bin",
    size: 10,
  });
  await service.append(
    ownerId,
    agentId,
    partial.id,
    0,
    chunks(Buffer.from("12345")),
  );
  await service.remove(ownerId, agentId, partial.id);
  assert.deepEqual(
    await readdir(path.join(volume.root, attachmentStagingFolder)),
    [],
  );
  const unsent = await upload("draft.txt", Buffer.from("draft"));
  await service.remove(ownerId, agentId, unsent.id);
  await assert.rejects(readFile(volume.local(unsent.path)), { code: "ENOENT" });
  const sent = await upload("sent.txt", Buffer.from("kept"));
  records.claim([sent.id], randomUUID());
  await assert.rejects(
    service.remove(ownerId, agentId, sent.id),
    AttachmentInUseError,
  );
  assert.equal(await readFile(volume.local(sent.path), "utf8"), "kept");
  assert.deepEqual(
    (await service.unsent(ownerId, agentId)).attachments.map((item) => item.id),
    [],
  );
});

test("a file the teammate deleted or replaced with a link is no longer available", async (context) => {
  const { service, volume, upload } = await fixture(context);
  const moved = await upload("moved.txt", Buffer.from("x"));
  await rm(volume.local(moved.path));
  await assert.rejects(
    service.content(ownerId, agentId, moved.id),
    AttachmentNotFoundError,
  );
});

test("a file that can't be placed is removed with its record and partial bytes", async (context) => {
  const { service, records, volume } = await fixture(context);
  await mkdir(volume.workspace(agentId), { recursive: true });
  await mkdir(volume.workspace(otherAgentId), { recursive: true });
  await symlink(
    volume.workspace(otherAgentId),
    path.join(volume.workspace(agentId), attachmentFolder),
  );
  const upload = await service.create(ownerId, agentId, {
    name: "notes.txt",
    size: 2,
  });
  await assert.rejects(
    service.append(ownerId, agentId, upload.id, 0, chunks(Buffer.from("hi"))),
    AttachmentStorageError,
  );
  assert.equal(records.rows.size, 0);
  assert.deepEqual(
    await readdir(path.join(volume.root, attachmentStagingFolder)),
    [],
  );
  assert.deepEqual(await readdir(volume.workspace(otherAgentId)), []);
});
