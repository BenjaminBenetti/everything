import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { attachmentStagingFolder } from "../model/attachment-file.js";
import { AttachmentExpiry } from "../service/attachment-expiry.js";
import { AttachmentExpiryScheduler } from "../service/attachment-expiry-scheduler.js";
import { AttachmentService } from "../service/attachment-service.js";
import {
  agentId,
  agents,
  chunks,
  MemoryAttachments,
  ownerId,
  workspaceVolume,
} from "./attachment-fixtures.js";

test("expiry removes abandoned uploads, old unsent files, and orphaned partials, never sent files", async (context) => {
  const volume = await workspaceVolume(context);
  const records = new MemoryAttachments();
  const service = new AttachmentService(agents, records, volume.files);
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  /** Upload a complete file. */
  async function ready(name: string) {
    const upload = await service.create(ownerId, agentId, { name, size: 2 });
    return service.append(
      ownerId,
      agentId,
      upload.id,
      0,
      chunks(Buffer.from("ok")),
    );
  }
  const abandoned = await service.create(ownerId, agentId, {
    name: "abandoned.bin",
    size: 10,
  });
  await service.append(
    ownerId,
    agentId,
    abandoned.id,
    0,
    chunks(Buffer.from("123")),
  );
  records.age(abandoned.id, "2026-10-31T11:00:00.000Z");
  const active = await service.create(ownerId, agentId, {
    name: "active.bin",
    size: 10,
  });
  records.age(active.id, "2026-10-31T11:59:00.000Z");
  const old = await ready("old.txt");
  records.age(old.id, "2026-10-30T11:00:00.000Z");
  const recent = await ready("recent.txt");
  records.age(recent.id, "2026-10-31T11:00:00.000Z");
  const sent = await ready("sent.txt");
  records.claim([sent.id], randomUUID());
  records.age(sent.id, "2026-01-01T00:00:00.000Z");
  // A partial file whose record never got saved, left long ago.
  const orphan = randomUUID();
  await volume.files.begin(orphan);
  const longAgo = new Date("2026-10-30T00:00:00.000Z");
  await utimes(
    path.join(volume.root, attachmentStagingFolder, `${orphan}.part`),
    longAgo,
    longAgo,
  );
  await new AttachmentExpiry(records, volume.files, () => now).expire();
  assert.deepEqual(
    [...records.rows.keys()].sort(),
    [active.id, recent.id, sent.id].sort(),
  );
  assert.deepEqual(
    (await readdir(path.join(volume.root, attachmentStagingFolder))).sort(),
    [`${active.id}.part`],
  );
  await assert.rejects(readFile(volume.local(old.path)), { code: "ENOENT" });
  assert.equal(await readFile(volume.local(recent.path), "utf8"), "ok");
  assert.equal(await readFile(volume.local(sent.path), "utf8"), "ok");
});

test("the scheduler runs one pass at a time and reports failures without details", async () => {
  let passes = 0;
  let release!: () => void;
  const failures: string[] = [];
  const scheduler = new AttachmentExpiryScheduler(
    {
      async expire() {
        passes++;
        if (passes === 2) throw new Error("/workspace/private/path");
        await new Promise<void>((resolve) => (release = resolve));
      },
    },
    () => failures.push("failed"),
  );
  scheduler.start();
  const again = scheduler.refresh();
  release();
  await again;
  assert.equal(passes, 1);
  await scheduler.refresh();
  assert.deepEqual(failures, ["failed"]);
  await scheduler.close();
  await scheduler.refresh();
  assert.equal(passes, 2);
});
