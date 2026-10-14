import assert from "node:assert/strict";
import { test } from "node:test";
import { messagePreview } from "../service/message-summary.js";

test("labeled fallback previews preserve source identifiers and code rather than interpreting Markdown", () => {
  assert.equal(
    messagePreview("Use `2 ** 3` and `__init__.py`.\nKeep the file name."),
    "Use `2 ** 3` and `__init__.py`. Keep the file name.",
  );
  assert.equal(
    messagePreview("Need your approval before continuing?"),
    "Need your approval before continuing?",
  );
});

test("fallback previews and model output are bounded deterministically without inventing claims", () => {
  const text = "The build passed. ".repeat(1000);
  const summary = messagePreview(text);
  assert.equal(summary, messagePreview(text));
  assert.ok(summary.length <= 280);
  assert.ok(summary.endsWith("…"));
  assert.ok(text.startsWith(summary.slice(0, -1)));
  assert.equal(messagePreview("x".repeat(1000)).length, 280);
  assert.equal(messagePreview("***"), "***");
});
