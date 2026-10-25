import assert from "node:assert/strict";
import { test } from "node:test";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import {
  describeHeld,
  hasLoneSurrogate,
  observeFirstBuffers,
  type BufferedRecord,
} from "./first-buffer-observer.js";
import {
  canaries,
  deliveredText,
  privateWords,
  recordCanaryWork,
  workSpans,
} from "./first-buffer-work.js";
import { exportedText, startInMemoryTelemetry } from "./telemetry-fixtures.js";

// An installation that set `telemetry.includeErrorText: false` and `telemetry.includeContent: false`.
const telemetry = startInMemoryTelemetry({
  includeErrorText: false,
  includeContent: false,
});

/** The records named `name`. */
function named(records: readonly BufferedRecord[], name: string) {
  return records.filter((record) => record.name === name);
}

test("with content and error text withheld, neither reaches any buffer, and records say what was left out", async (context) => {
  telemetry.reset();
  const observer = observeFirstBuffers();
  context.after(() => observer.restore());
  const { deliveries, inspected, given } = await recordCanaryWork(context);
  const exported = await telemetry.collect();
  const restored = observer.restore();

  // Everything below runs here, outside every SDK call the observer was called from.
  const { held, batchedSpans, batchedLogs, errors } = observer.observations;
  assert.deepEqual(errors, [], "every record was copied");
  assert.ok(restored, "every observed method is back exactly as it was");
  context.diagnostic(
    `first buffers: ${held.length} spans held, ${batchedSpans.length} spans and ${batchedLogs.length} events queued`,
  );
  for (const name of Object.values(workSpans)) {
    assert.ok(named(held, name).length, `${name} reached the read filter`);
    assert.ok(named(batchedSpans, name).length, `${name} reached the batch`);
  }
  assert.ok(batchedLogs.length, "the provider's failure reached the batch");
  const withheldText = [
    ...Object.values(canaries),
    ...Object.values(privateWords),
    "Lookup failed",
    "Dependency said",
    "Invalid request",
    "FROM visits",
  ];
  for (const [buffer, records] of [
    ["read filter", held],
    ["span batch", batchedSpans],
    ["event batch", batchedLogs],
  ] as const)
    context.diagnostic(
      `${buffer}: ${describeHeld(records, { ...canaries, ...privateWords })}`,
    );
  for (const record of [...held, ...batchedSpans, ...batchedLogs]) {
    for (const text of withheldText)
      assert.ok(!record.text.includes(text), `${record.name} holds ${text}`);
    assert.ok(record.detached, `${record.name} is held as its own record`);
    assert.ok(!hasLoneSurrogate(record.text), `${record.name} is valid text`);
  }
  for (const name of [workSpans.turn, workSpans.query])
    for (const record of named(held, name))
      assert.equal(record.attributes[attribute.contentWithheld], true, name);
  assert.ok(
    named(held, workSpans.tool).every(
      (tool) => tool.attributes[attribute.contentWithheld] === true,
    ),
  );
  const [call] = named(held, workSpans.dependency);
  assert.equal(call!.attributes[attribute.textWithheld], true);
  assert.ok(
    batchedLogs.some(
      (event) => event.attributes[attribute.textWithheld] === true,
    ),
    "the provider's failure says its text was withheld",
  );

  const text = exportedText(exported);
  for (const value of withheldText)
    assert.ok(!text.includes(value), `${value} reached the export`);
  assert.deepEqual(deliveries, [deliveredText], "the tool still ran unchanged");
  assert.deepEqual(inspected, given, "the tool's arguments are unchanged");
});
