import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryPreview } from "@everything/telemetry-contracts";
import {
  formatPreview,
  isLongPreview,
  previewNote,
  relationLimits,
} from "../model/span-content.js";

/** A preview of `kind` with `value`. */
function preview(
  kind: TelemetryPreview["kind"],
  value: string,
  patch: Partial<TelemetryPreview> = {},
): TelemetryPreview {
  return {
    kind,
    format:
      kind === "tool_arguments" ? "json" : kind === "sql" ? "sql" : "text",
    value,
    truncated: false,
    originalLength: null,
    ...patch,
  };
}

test("tool arguments read as indented JSON, and anything that isn't JSON as stored", () => {
  assert.equal(
    formatPreview(preview("tool_arguments", '{"path":"a.txt","lines":[1,2]}')),
    '{\n  "path": "a.txt",\n  "lines": [\n    1,\n    2\n  ]\n}',
  );
  assert.equal(
    formatPreview(preview("tool_arguments", "{not json")),
    "{not json",
  );
  assert.equal(formatPreview(preview("sql", "SELECT 1")), "SELECT 1");
});

test("each preview says what it leaves out, and never promises the whole payload once shortened", () => {
  assert.match(
    previewNote(
      preview("message", "start…end", {
        truncated: true,
        originalLength: 12_345,
      }),
    ),
    /start and end of a 12,345-character message; the middle isn’t shown/,
  );
  assert.match(
    previewNote(preview("message", "short")),
    /^Recognizable credentials were removed/,
  );
  assert.match(
    previewNote(preview("tool_arguments", "{}", { truncated: true })),
    /isn’t everything the tool received/,
  );
  assert.match(previewNote(preview("sql", "SELECT $1")), /neither is recorded/);
  assert.match(
    previewNote(preview("sql", "SELECT", { truncated: true })),
    /its end isn’t shown/,
  );
});

test("long previews start collapsed", () => {
  assert.equal(isLongPreview("one line"), false);
  assert.equal(isLongPreview("line\n".repeat(9)), true);
  assert.equal(isLongPreview("x".repeat(601)), true);
});

test("a trace's relations say when linked work isn't available or more exist", () => {
  assert.deepEqual(
    relationLimits({ related: [], unresolved: false, truncated: false }),
    [],
  );
  assert.equal(
    relationLimits({ related: [], unresolved: true, truncated: true }).length,
    2,
  );
});
