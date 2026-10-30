import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentLocation,
  attachmentPath,
  classifyAttachment,
  displayName,
  storedFileName,
  storedFileNamePattern,
} from "../model/attachment-file.js";
import { agentId, binaryBytes, pngBytes } from "./attachment-fixtures.js";

const id = "44444444-4444-4444-8444-444444444444";

test("stored names never name a path, hidden file, option, or configuration file location", () => {
  const cases: [string, string][] = [
    ["report.csv", "report.csv"],
    ["../../.bashrc", "bashrc"],
    ["..\\..\\AGENTS.md", "AGENTS.md"],
    ["C:\\fakepath\\holiday photo.png", "holiday_photo.png"],
    [".ssh/authorized_keys", "authorized_keys"],
    ["-rf --no-preserve-root", "rf_--no-preserve-root"],
    ["résumé final.pdf", "resume_final.pdf"],
    ["\u202Egnp.exe", "gnp.exe"],
    ["..", "file"],
    ["   ", "file"],
    ["日本語.txt", "file.txt"],
    ["a\r\nContent-Type: text/html.txt", "html.txt"],
    ["a\r\nSet-Cookie: x=1.txt", "aSet-Cookie_x_1.txt"],
  ];
  for (const [name, expected] of cases) {
    const stored = storedFileName(name);
    assert.equal(stored, expected, name);
    assert.match(stored, storedFileNamePattern, name);
  }
  const long = storedFileName(`${"x".repeat(300)}.tar.gz`);
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith(".gz"));
});

test("display names keep the user's name without paths, controls, or direction overrides", () => {
  assert.equal(displayName("C:\\fakepath\\report.csv"), "report.csv");
  assert.equal(displayName("a/b/../c.txt"), "c.txt");
  assert.equal(displayName("line\nbreak\u202E.txt"), "linebreak.txt");
  assert.equal(displayName("résumé.pdf"), "résumé.pdf");
  assert.equal(displayName("\u0000"), "file");
  assert.equal([...displayName("é".repeat(400))].length, 255);
});

test("paths are server-generated under the teammate's attachments folder, and forged ones are refused", () => {
  const location = { agentId, id, fileName: "report.csv" };
  const saved = attachmentPath(location);
  assert.equal(saved, `/workspace/${agentId}/attachments/${id}/report.csv`);
  assert.deepEqual(attachmentLocation(agentId, id, saved), location);
  for (const forged of [
    `/workspace/${agentId}/attachments/${id}/../../.bashrc`,
    `/workspace/${agentId}/.bashrc`,
    `/workspace/other/attachments/${id}/report.csv`,
    `/workspaces/everything-splash/report.csv`,
    "C:\\fakepath\\report.csv",
  ])
    assert.throws(() => attachmentLocation(agentId, id, forged), forged);
  assert.throws(() => attachmentPath({ agentId: "../etc", id, fileName: "x" }));
  assert.throws(() =>
    attachmentPath({ agentId, id: "not-an-id", fileName: "x" }),
  );
  assert.throws(() => attachmentPath({ agentId, id, fileName: ".bashrc" }));
});

test("kinds come from the bytes, never from the name or the browser's type", () => {
  assert.deepEqual(classifyAttachment(pngBytes), {
    kind: "image",
    mediaType: "image/png",
  });
  assert.deepEqual(classifyAttachment(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), {
    kind: "image",
    mediaType: "image/jpeg",
  });
  assert.deepEqual(classifyAttachment(Buffer.from("GIF89a....")), {
    kind: "image",
    mediaType: "image/gif",
  });
  assert.deepEqual(classifyAttachment(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), {
    kind: "image",
    mediaType: "image/webp",
  });
  assert.deepEqual(classifyAttachment(Buffer.from("%PDF-1.7\n")), {
    kind: "binary",
    mediaType: "application/pdf",
  });
  assert.deepEqual(classifyAttachment(binaryBytes), {
    kind: "binary",
    mediaType: "application/octet-stream",
  });
  // SVG and HTML are text, so they are never displayed inline as images.
  for (const markup of ["<svg onload=alert(1)>", "<html><script>1</script>"])
    assert.deepEqual(classifyAttachment(Buffer.from(markup)), {
      kind: "text",
      mediaType: "text/plain",
    });
  assert.deepEqual(classifyAttachment(new Uint8Array()), {
    kind: "text",
    mediaType: "text/plain",
  });
  // A multi-byte character cut off by the sample is still text.
  assert.deepEqual(classifyAttachment(Buffer.from("añ").subarray(0, 2)), {
    kind: "text",
    mediaType: "text/plain",
  });
});
