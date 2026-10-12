import assert from "node:assert/strict";
import { test } from "node:test";
import { timestampTransformer } from "../schema/base-columns.js";

test("timestamps convert between ISO strings and dates, keeping null and undefined", () => {
  const iso = "2026-10-12T03:55:04.507Z";
  assert.deepEqual(timestampTransformer.to(iso), new Date(iso));
  assert.equal(timestampTransformer.from(new Date(iso)), iso);
  assert.equal(timestampTransformer.to(null), null);
  assert.equal(timestampTransformer.to(undefined), undefined);
  assert.equal(timestampTransformer.from(null), null);
});
