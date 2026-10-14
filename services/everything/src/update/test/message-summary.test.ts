import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeMessage } from "../service/message-summary.js";

test("summaries retain actual content, link labels, questions, and code without Markdown layout", () => {
  assert.equal(
    summarizeMessage(
      "## Build ready\n\n**All 12 checks passed.** See [the PR](https://example.com/pr/1).\n- Can you review it?",
    ),
    "Build ready All 12 checks passed. See the PR. Can you review it?",
  );
  assert.equal(
    summarizeMessage("```ts\nconst result = 2 * 3;\n```"),
    "const result = 2 * 3;",
  );
  assert.equal(
    summarizeMessage(
      "![Screenshot](https://example.com/image.png)\nThe chart is ready.",
    ),
    "Screenshot The chart is ready.",
  );
  assert.equal(
    summarizeMessage("Need your approval before continuing?"),
    "Need your approval before continuing?",
  );
});

test("summaries are deterministic and bounded even for long or unusual content", () => {
  const text = "The build passed. ".repeat(1000);
  const summary = summarizeMessage(text);
  assert.equal(summary, summarizeMessage(text));
  assert.ok(summary.length <= 280);
  assert.ok(summary.endsWith("…"));
  assert.ok(text.startsWith(summary.slice(0, -1)));
  assert.equal(summarizeMessage("x".repeat(1000)).length, 280);
  assert.ok(summarizeMessage("***").length > 0);
});
