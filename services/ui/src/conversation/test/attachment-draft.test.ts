import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentLimits,
  type AttachmentUpload,
} from "@everything/conversation-contracts/attachment";
import {
  admitFiles,
  draftFor,
  draftReducer,
  draftSummary,
  formatSize,
  type DraftAttachment,
} from "../model/attachment-draft.js";

/** A server upload in the given state. */
function upload(
  id: string,
  changes: Partial<AttachmentUpload> = {},
): AttachmentUpload {
  return {
    id,
    name: `${id}.txt`,
    size: 10,
    received: 0,
    status: "uploading",
    kind: null,
    mediaType: null,
    path: `/workspace/teammate/attachments/${id}/${id}.txt`,
    ...changes,
  };
}

test("only raster images get a local preview, so markup files never render", () => {
  let previews = 0;
  const preview = () => `blob:preview-${++previews}`;
  assert.equal(
    draftFor("a", { name: "a.png", size: 1, type: "image/png" }, preview)
      .preview,
    "blob:preview-1",
  );
  for (const type of ["image/svg+xml", "text/html", "application/pdf", ""])
    assert.equal(
      draftFor("b", { name: "b", size: 1, type }, preview).preview,
      null,
      type,
    );
  assert.equal(previews, 1);
});

test("uploads progress to ready, fail with a reason, retry, and leave the tray once sent", () => {
  let state: readonly DraftAttachment[] = [];
  state = draftReducer(state, {
    type: "added",
    items: [
      draftFor(
        "one",
        { name: "one.txt", size: 10, type: "text/plain" },
        () => "",
      ),
      draftFor("two", { name: "two.bin", size: 10, type: "" }, () => ""),
    ],
  });
  state = draftReducer(state, {
    type: "progressed",
    key: "one",
    upload: upload("u1", { received: 4 }),
  });
  assert.deepEqual(draftSummary(state), {
    readyIds: [],
    readyKeys: [],
    uploading: 2,
    failed: 0,
  });
  state = draftReducer(state, {
    type: "progressed",
    key: "one",
    upload: upload("u1", {
      received: 10,
      status: "ready",
      kind: "text",
      mediaType: "text/plain",
    }),
  });
  state = draftReducer(state, {
    type: "failed",
    key: "two",
    error: "The upload stopped.",
  });
  assert.deepEqual(draftSummary(state), {
    readyIds: ["u1"],
    readyKeys: ["one"],
    uploading: 0,
    failed: 1,
  });
  assert.equal(state[1]!.error, "The upload stopped.");
  state = draftReducer(state, { type: "retrying", key: "two" });
  assert.equal(state[1]!.status, "uploading");
  assert.equal(state[1]!.error, null);
  state = draftReducer(state, { type: "sent", keys: ["one"] });
  assert.deepEqual(
    state.map((item) => item.key),
    ["two"],
  );
  state = draftReducer(state, { type: "removed", key: "two" });
  assert.deepEqual(state, []);
});

test("a reload restores unsent files once; interrupted uploads can only be removed", () => {
  const restored = draftReducer([], {
    type: "restored",
    uploads: [
      upload("ready", {
        status: "ready",
        received: 10,
        kind: "image",
        mediaType: "image/png",
      }),
      upload("interrupted", { received: 3 }),
    ],
    preview: (item) => `/v1/agents/a/attachments/${item.id}/content`,
  });
  assert.deepEqual(
    restored.map((item) => [item.key, item.status, item.retryable]),
    [
      ["ready", "ready", false],
      ["interrupted", "failed", false],
    ],
  );
  assert.equal(restored[0]!.preview, "/v1/agents/a/attachments/ready/content");
  assert.match(restored[1]!.error!, /interrupted/);
  // React may run the restore twice in development; it must not duplicate files.
  const again = draftReducer(restored, {
    type: "restored",
    uploads: [upload("ready", { status: "ready", received: 10 })],
    preview: () => null,
  });
  assert.equal(again.length, 2);
});

test("files over the per-file, count, or combined limit are explained instead of added", () => {
  const mb = 1024 * 1024;
  const current = Array.from({ length: 8 }, (_, index) =>
    draftFor(
      `k${index}`,
      { name: `f${index}`, size: 10 * mb, type: "" },
      () => "",
    ),
  );
  const { accepted, problems } = admitFiles(current, [
    { name: "huge.mov", size: attachmentLimits.maxFileBytes + 1 },
    { name: "a.pdf", size: 15 * mb },
    { name: "b.pdf", size: 6 * mb },
    { name: "c.txt", size: 1 },
  ]);
  assert.deepEqual(
    accepted.map((file) => file.name),
    ["a.pdf", "c.txt"],
  );
  assert.deepEqual(problems, [
    "huge.mov is larger than 25 MB.",
    "b.pdf wasn’t added: files in one message can total up to 100 MB.",
  ]);
  const full = admitFiles(
    [...current, ...current.slice(0, 2)].map((item, index) => ({
      ...item,
      key: String(index),
      size: 1,
    })),
    [{ name: "eleventh.txt", size: 1 }],
  );
  assert.deepEqual(full.problems, [
    "eleventh.txt wasn’t added: a message can have up to 10 files.",
  ]);
});

test("sizes read naturally", () => {
  assert.equal(formatSize(0), "0 bytes");
  assert.equal(formatSize(1), "1 byte");
  assert.equal(formatSize(12_634), "12.3 KB");
  assert.equal(formatSize(1_258_291), "1.2 MB");
  assert.equal(formatSize(25 * 1024 * 1024), "25 MB");
});
