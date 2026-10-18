import assert from "node:assert/strict";
import { test } from "node:test";
import {
  notificationPreview,
  notificationPreviewMaxLength,
} from "../model/notification-preview.js";

test("Markdown syntax is removed and blocks read as one line", () => {
  assert.equal(
    notificationPreview(
      "# Release notes\n\nThe **build** is _ready_ — see [the report](https://example.com/r).\n\n- `npm test` passed\n- ~~lint~~ fixed\n\n> Ship it?",
    ),
    "Release notes The build is ready — see the report. npm test passed lint fixed Ship it?",
  );
});

test("raw HTML tags never appear, while their text and decoded entities remain", () => {
  assert.equal(
    notificationPreview(
      '<script>alert("x")</script>\n\nDone <b>now</b> &amp; <img src=x onerror=alert(1)> later',
    ),
    "Done now & later",
  );
});

test("images keep their description, tables and code keep their text, definitions disappear", () => {
  assert.equal(
    notificationPreview(
      "![Chart of weekly sales](chart.png)\n\n| Day | Sales |\n| --- | --- |\n| Mon | 3 |\n\n```ts\nconst total = 3;\n```\n\n[ref]: https://example.com",
    ),
    "Chart of weekly sales Day Sales Mon 3 const total = 3;",
  );
});

test("control characters and bidirectional overrides can't rearrange the preview", () => {
  assert.equal(
    notificationPreview("Invoice\u202Egnp.exe\u0007 is\u200F ready"),
    "Invoice gnp.exe is ready",
  );
});

test("long messages are clamped on a word boundary with an ellipsis", () => {
  const preview = notificationPreview(
    `${"Finished the migration plan for every service ".repeat(10)}end`,
  );
  assert.ok(preview.length <= notificationPreviewMaxLength);
  assert.ok(preview.endsWith("…"));
  assert.ok(!preview.endsWith(" …"));
  assert.ok(
    "Finished the migration plan for every service "
      .repeat(10)
      .startsWith(preview.slice(0, -1)),
  );
});

test("an unbroken long word is still clamped", () => {
  const preview = notificationPreview("x".repeat(500));
  assert.equal(preview.length, notificationPreviewMaxLength);
  assert.ok(preview.endsWith("…"));
});

test("messages with nothing readable produce an empty preview", () => {
  assert.equal(notificationPreview("<br>\n\n---\n\n<div></div>"), "");
  assert.equal(notificationPreview("   \n\t "), "");
});
