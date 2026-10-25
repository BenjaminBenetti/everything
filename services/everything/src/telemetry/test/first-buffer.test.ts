import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import { sendMessageToolName } from "../../runtime/model/message-delivery.js";
import { RedactingSpanProcessor } from "../adapter/redacting-processors.js";
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
  rawCanary,
  rawSyntheticSpan,
  recordCanaryWork,
  recordSyntheticSpan,
  restoredCanary,
  statementShape,
  workSpans,
} from "./first-buffer-work.js";
import { exportedText, startInMemoryTelemetry } from "./telemetry-fixtures.js";

// Content and error text recorded, as installations do by default.
const telemetry = startInMemoryTelemetry({
  includeErrorText: true,
  includeContent: true,
});

/** The canary values a record's text carries. */
function carried(record: BufferedRecord): string[] {
  return Object.values(canaries).filter((canary) =>
    record.text.includes(canary),
  );
}

/** The records named `name`. */
function named(records: readonly BufferedRecord[], name: string) {
  return records.filter((record) => record.name === name);
}

test("by default, every span and event reaches its first buffer already redacted and detached, with its content, and the work it describes is unchanged", async (context) => {
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
  for (const [buffer, records] of [
    ["read filter", held],
    ["span batch", batchedSpans],
    ["event batch", batchedLogs],
  ] as const)
    context.diagnostic(`${buffer}: ${describeHeld(records, canaries)}`);
  for (const name of Object.values(workSpans)) {
    assert.ok(named(held, name).length, `${name} reached the read filter`);
    assert.ok(named(batchedSpans, name).length, `${name} reached the batch`);
  }
  assert.ok(batchedLogs.length, "the provider's failure reached the batch");
  for (const record of [...held, ...batchedSpans, ...batchedLogs]) {
    assert.deepEqual(carried(record), [], `${record.name} carries a canary`);
    assert.ok(record.detached, `${record.name} is held as its own record`);
    assert.ok(!hasLoneSurrogate(record.text), `${record.name} is valid text`);
  }

  // What's recorded is still there, redacted, before it waits anywhere.
  const [turn] = named(held, workSpans.turn);
  assert.match(
    String(turn!.attributes[attribute.messagePreview]),
    new RegExp(
      `^Plan: ${privateWords.message}\\. Call https://gateway\\.test/v1/`,
    ),
  );
  const tools = named(held, workSpans.tool);
  assert.deepEqual(
    tools.map((tool) => tool.attributes[attribute.tool]).sort(),
    ["[redacted]", "inspect_request", sendMessageToolName].sort(),
    "a key-shaped tool name a model made up is redacted",
  );
  for (const tool of tools)
    JSON.parse(String(tool.attributes[attribute.toolArguments]));
  const queries = named(held, workSpans.query);
  assert.deepEqual(
    queries.map(
      (query) =>
        query.attributes[attribute.dbQueryText] ??
        query.attributes[attribute.dbStatement],
    ),
    [statementShape, statementShape],
  );
  for (const query of queries)
    assert.ok(
      !Object.keys(query.attributes).some((key) => key.includes("parameter")),
      "no parameter value is held",
    );
  const [call] = named(held, workSpans.dependency);
  assert.equal(
    call!.attributes[attribute.urlFull],
    "https://dependency.test/resource",
  );
  assert.match(call!.text, /Lookup failed with password=\[redacted\]/);
  assert.ok(call!.text.includes(privateWords.error), "error text is recorded");
  assert.ok(
    batchedLogs.some((event) => event.text.includes(privateWords.error)),
    "the provider's error text is recorded in its event",
  );

  // The export is as safe, and the work ran with exactly what it was given.
  const text = exportedText(exported);
  for (const canary of Object.values(canaries))
    assert.ok(!text.includes(canary), `${canary} reached the export`);
  assert.deepEqual(deliveries, [deliveredText]);
  assert.deepEqual(inspected, given, "the tool's arguments are unchanged");
});

test("a raw record handed straight to the first buffer is seen there, though the exporter hides it", async (context) => {
  telemetry.reset();
  const observer = observeFirstBuffers();
  context.after(() => observer.restore());
  // A span through the pipeline, so the observer meets the runtime's read filter.
  await recordCanaryWork(context);
  const [filter] = observer.observations.filters;
  assert.ok(filter, "the runtime's read filter was observed");
  filter.onEnd(rawSyntheticSpan());
  const exported = await telemetry.collect();
  const restored = observer.restore();

  const { held, batchedSpans, errors } = observer.observations;
  assert.deepEqual(errors, []);
  assert.ok(restored);
  const [raw] = named(held, "raw.synthetic");
  assert.ok(raw, "the raw record reached the read filter");
  assert.ok(raw.text.includes(rawCanary), "the observer sees its canary");
  assert.equal(raw.detached, false, "and that it is the SDK's own span");
  assert.ok(
    named(batchedSpans, "raw.synthetic")[0]?.text.includes(rawCanary),
    "the batch holds it raw too",
  );
  const [shipped] = exported.spans.filter(
    (span) => span.name === "raw.synthetic",
  );
  assert.ok(shipped, "the raw record is exported");
  assert.ok(
    !exportedText({ spans: [shipped], events: [] }).includes(rawCanary),
    "the final exporter hides what the first buffer held",
  );
  context.diagnostic(
    "negative control: a raw record reached the first buffer and the observer saw its canary",
  );
});

test("with the redacting processor bypassed, the first buffer receives the raw span, which the observer sees though the exporter hides it; put back, records are safe again", async (context) => {
  telemetry.reset();
  const observer = observeFirstBuffers();
  context.after(() => observer.restore());
  const prototype = RedactingSpanProcessor.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "onEnd")!;
  context.after(() => Object.defineProperty(prototype, "onEnd", descriptor));
  // Bypassed: the SDK's span is passed on as it is, as if nothing made it safe.
  Object.defineProperty(prototype, "onEnd", {
    ...descriptor,
    value: function (this: { next: SpanProcessor }, span: ReadableSpan) {
      this.next.onEnd(span);
    },
  });
  recordSyntheticSpan("bypassed.synthetic", rawCanary);
  Object.defineProperty(prototype, "onEnd", descriptor);
  const putBack =
    Object.getOwnPropertyDescriptor(prototype, "onEnd")?.value ===
    descriptor.value;
  recordSyntheticSpan("restored.synthetic", restoredCanary);
  const exported = await telemetry.collect();
  const restored = observer.restore();

  const { held, errors } = observer.observations;
  assert.deepEqual(errors, []);
  assert.ok(restored, "the observer put every method back exactly");
  assert.ok(putBack, "the redacting processor is back exactly as it was");
  const [bypassed] = named(held, "bypassed.synthetic");
  assert.ok(bypassed, "the bypassed span reached the read filter");
  assert.ok(bypassed.text.includes(rawCanary), "the observer sees its canary");
  assert.equal(bypassed.detached, false, "and that it is the SDK's own span");
  const [safe] = named(held, "restored.synthetic");
  assert.ok(safe, "the next span reached the read filter");
  assert.deepEqual(carried(safe), [], "redacted again once put back");
  assert.ok(!safe.text.includes(restoredCanary));
  assert.ok(safe.detached);
  const text = exportedText(exported);
  assert.ok(
    exported.spans.some((span) => span.name === "bypassed.synthetic"),
    "the bypassed span is still exported",
  );
  for (const canary of [rawCanary, restoredCanary])
    assert.ok(!text.includes(canary), "the final exporter hides both");
  context.diagnostic(
    "negative control: bypassing the redacting processor put a raw span in the first buffer, which the observer saw; put back, the next span was safe",
  );
});
