import assert from "node:assert/strict";
import { test } from "node:test";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import { truncationMarker } from "../service/telemetry-redactor.js";
import {
  canaries,
  embeddedSecret,
  recordErrorText,
  requestIds,
} from "./error-text-fixtures.js";
import {
  eventsNamed,
  exportedText,
  spansNamed,
  startInMemoryTelemetry,
} from "./telemetry-fixtures.js";

// This process records error text, as an installation that opts in does.
const telemetry = startInMemoryTelemetry({ includeErrorText: true });

/** Every exported error text value: messages, status messages, and exception messages. */
function errorTexts(
  exported: Awaited<ReturnType<typeof telemetry.collect>>,
): string[] {
  return [
    ...exported.events.map((event) => event.attributes[attribute.message]),
    ...exported.spans.flatMap((span) => [
      span.attributes[attribute.message],
      span.status.message,
      ...span.events.map((event) => event.attributes?.["exception.message"]),
    ]),
  ].filter((value): value is string => typeof value === "string");
}

test("with error text recorded, only errors' own messages are exported, redacted and bounded, beside the same structured diagnosis", async (context) => {
  telemetry.reset();
  await recordErrorText(context);
  const exported = await telemetry.collect();
  const text = exportedText(exported);
  assert.ok(!text.includes(embeddedSecret), "credentials are always redacted");
  assert.ok(
    !text.includes(canaries.input),
    "a provider error body's other fields are never kept, even without a message",
  );
  for (const value of errorTexts(exported))
    assert.ok(value.length <= 400, `error text is bounded: ${value.length}`);

  const models = eventsNamed(exported, telemetryEvents.modelFailed);
  const quoting = models.find(
    (model) => model.attributes[attribute.requestId] === requestIds.canonical,
  );
  const message = String(quoting?.attributes[attribute.message]);
  assert.ok(
    message.startsWith(
      `Rejected prompt: ${canaries.canonical} api_key=[redacted]`,
    ),
    message,
  );
  assert.ok(message.endsWith(truncationMarker));
  assert.ok(message.length <= 300, "a provider's excerpt is 300 characters");
  assert.equal(quoting?.attributes[attribute.textWithheld], undefined);
  const echoing = models.find(
    (model) => model.attributes[attribute.requestId] === requestIds.input,
  );
  assert.equal(echoing?.attributes[attribute.message], undefined);
  for (const model of models) {
    assert.equal(model.attributes[attribute.category], "invalid_request");
    assert.equal(model.attributes[attribute.code], "invalid_request_error");
    assert.equal(model.attributes[attribute.httpStatus], 400);
    assert.equal(model.attributes[attribute.attempts], 1);
  }
  const requests = spansNamed(exported, telemetrySpans.providerRequest);
  assert.ok(
    requests.some((span) =>
      String(span.attributes[attribute.message]).includes(canaries.canonical),
    ),
  );
  assert.ok(requests.every((span) => span.status.message === "HTTP 400"));

  const [compaction] = eventsNamed(exported, telemetryEvents.compactionFailed);
  assert.equal(
    compaction?.attributes[attribute.message],
    `Context rejected: ${canaries.compaction}`,
  );

  const library = exported.spans.find((span) =>
    span.name.startsWith("pg.query"),
  );
  assert.equal(library?.status.message, canaries.library);
  assert.equal(
    library?.events[0]?.attributes?.["exception.message"],
    canaries.library,
  );

  const [requestFailed] = eventsNamed(exported, telemetryEvents.requestFailed);
  assert.equal(
    requestFailed?.attributes[attribute.message],
    `Lookup failed ← Provider said: ${canaries.cause}`,
  );

  const [warning] = eventsNamed(exported, telemetryEvents.warning);
  assert.equal(
    warning?.attributes[attribute.message],
    `connect failed: ${canaries.warning}`,
  );
});
