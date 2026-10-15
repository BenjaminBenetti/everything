import assert from "node:assert/strict";
import { test } from "node:test";
import { updateSummaryMaxLength } from "@everything/update-contracts";
import { clampSummary, unwrapQuotes } from "../service/summary-text.js";

test("previews normalize whitespace but keep identifiers, code, and Markdown as written", () => {
  assert.equal(
    clampSummary("Use `2 ** 3` and `__init__.py`.\nKeep the file name."),
    "Use `2 ** 3` and `__init__.py`. Keep the file name.",
  );
  assert.equal(
    clampSummary("  Needs your approval before continuing?  "),
    "Needs your approval before continuing?",
  );
  assert.equal(clampSummary("***"), "***");
});

test("long text is clamped to the limit on a word boundary and marked as cut", () => {
  const text = "The build passed, ".repeat(100);
  const summary = clampSummary(text);
  assert.equal(summary, clampSummary(text));
  assert.ok(summary.length <= updateSummaryMaxLength);
  assert.ok(summary.endsWith("passed…"), summary);
  assert.ok(text.startsWith(summary.slice(0, -1)));
  const exact = `${"a".repeat(updateSummaryMaxLength - 1)} tail`;
  assert.equal(
    clampSummary(exact),
    `${"a".repeat(updateSummaryMaxLength - 1)}…`,
  );
  assert.equal(
    clampSummary("x".repeat(1000)).length,
    updateSummaryMaxLength,
    "A single long word is cut at the limit",
  );
  assert.equal(clampSummary("y".repeat(updateSummaryMaxLength)).length, 200);
});

test("quotation marks wrapped around a whole answer are removed, but inner quotes stay", () => {
  assert.equal(
    unwrapQuotes('"Needs your choice: A or B?"'),
    "Needs your choice: A or B?",
  );
  assert.equal(unwrapQuotes("“Shared a pun.”"), "Shared a pun.");
  assert.equal(unwrapQuotes('"A" and "B" are ready'), '"A" and "B" are ready');
  assert.equal(
    unwrapQuotes("Renamed the 'old' file."),
    "Renamed the 'old' file.",
  );
});
