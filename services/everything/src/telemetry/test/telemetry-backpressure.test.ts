import assert from "node:assert/strict";
import { test } from "node:test";
import { telemetryEvents } from "../model/telemetry-attributes.js";
import { recordTelemetryEvent } from "../service/telemetry-recorder.js";
import { startInMemoryTelemetry } from "./telemetry-fixtures.js";

// A queue of eight records with a long batch delay overflows on purpose.
const telemetry = startInMemoryTelemetry({
  queueSize: 8,
  batchDelayMs: 60_000,
});

test("a full export queue drops further records, counts them, and never blocks the caller", async () => {
  const started = performance.now();
  for (let index = 0; index < 50; index++)
    recordTelemetryEvent({
      name: telemetryEvents.warning,
      title: "Background warning",
      type: "log",
      severity: "warning",
    });
  assert.ok(
    performance.now() - started < 1_000,
    "recording stays fast when the queue is full",
  );
  const { events } = await telemetry.collect();
  const dropped = telemetry.runtime.health().droppedRecords;
  assert.ok(dropped > 0, "records beyond the queue are dropped");
  assert.equal(
    events.length + dropped,
    50,
    "every record is either exported or counted as dropped",
  );
});
