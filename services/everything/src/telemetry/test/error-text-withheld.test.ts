import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import {
  canaries,
  embeddedSecret,
  lookalikeStatus,
  recordErrorText,
  requestIds,
  toolKey,
} from "./error-text-fixtures.js";
import {
  eventsNamed,
  exportedText,
  spansNamed,
  startInMemoryTelemetry,
} from "./telemetry-fixtures.js";

// This installation withholds error text, as `telemetry.includeErrorText: false` does.
const telemetry = startInMemoryTelemetry({ includeErrorText: false });

test("with error text withheld, no error text reaches any exported span, span event, or event, while its structured diagnosis does", async (context) => {
  telemetry.reset();
  await recordErrorText(context);
  const exported = await telemetry.collect();
  const text = exportedText(exported);
  for (const [surface, canary] of Object.entries(canaries))
    assert.ok(!text.includes(canary), `${surface} error text is withheld`);
  for (const fragment of [
    embeddedSecret,
    toolKey,
    lookalikeStatus,
    "Rejected prompt",
    "Context rejected",
    "Provider said",
    "connect failed",
  ])
    assert.ok(!text.includes(fragment), `${fragment} is withheld`);

  const failures = eventsNamed(exported, telemetryEvents.modelFailed);
  assert.equal(failures.length, 4, "two 400s and two stream errors");
  const models = failures.filter(
    (model) => model.attributes[attribute.httpStatus] === 400,
  );
  for (const model of models) {
    assert.equal(model.attributes[attribute.category], "invalid_request");
    assert.equal(model.attributes[attribute.code], "invalid_request_error");
    assert.equal(model.attributes[attribute.httpStatus], 400);
    assert.equal(model.attributes[attribute.retryable], false);
    assert.equal(model.attributes[attribute.attempts], 1);
    assert.equal(model.attributes[attribute.provider], "openai-compatible");
    assert.equal(model.attributes[attribute.model], "o3-mini");
    assert.equal(model.attributes[attribute.ownerId], "owner-a");
    assert.equal(model.attributes[attribute.message], undefined);
    assert.equal(model.body, "Model request failed");
  }
  assert.deepEqual(
    models.map((model) => model.attributes[attribute.requestId]).sort(),
    [requestIds.canonical, requestIds.input],
  );
  assert.equal(
    models.find(
      (model) => model.attributes[attribute.requestId] === requestIds.canonical,
    )?.attributes[attribute.textWithheld],
    true,
    "a withheld message is marked",
  );

  const streams = failures.filter(
    (model) => model.attributes[attribute.requestId] === requestIds.stream,
  );
  assert.equal(streams.length, 2);
  for (const stream of streams) {
    assert.equal(stream.attributes[attribute.category], "unknown");
    assert.equal(stream.attributes[attribute.httpStatus], 200);
    assert.equal(stream.attributes[attribute.message], undefined);
  }

  const requests = spansNamed(exported, telemetrySpans.providerRequest).filter(
    (span) => span.status.code === SpanStatusCode.ERROR,
  );
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.status.message, "HTTP 400");
    assert.equal(request.attributes[attribute.code], "invalid_request_error");
    assert.equal(request.attributes[attribute.message], undefined);
  }
  const prompts = spansNamed(exported, telemetrySpans.prompt).filter(
    (span) => span.status.code === SpanStatusCode.ERROR,
  );
  assert.ok(
    prompts.some(
      (span) => span.status.message === "Model request failed: invalid_request",
    ),
    "Everything's own status text is kept",
  );

  const [compaction] = eventsNamed(exported, telemetryEvents.compactionFailed);
  assert.equal(compaction?.attributes[attribute.category], "invalid_request");
  assert.equal(compaction?.attributes[attribute.code], "invalid_request_error");
  assert.equal(compaction?.attributes[attribute.reason], "threshold");
  assert.equal(compaction?.attributes[attribute.textWithheld], true);
  const [compactionSpan] = spansNamed(exported, telemetrySpans.compaction);
  assert.equal(compactionSpan?.status.message, "Context compaction failed");
  assert.equal(compactionSpan?.attributes[attribute.textWithheld], true);

  const library = exported.spans.find((span) =>
    span.name.startsWith("pg.query"),
  );
  assert.equal(library?.status.code, SpanStatusCode.ERROR);
  assert.equal(library?.status.message, undefined);
  assert.equal(library?.attributes[attribute.severity], "error");
  assert.equal(library?.attributes[attribute.ownerId], "owner-a");
  assert.equal(library?.attributes[attribute.textWithheld], true);
  assert.deepEqual(library?.events[0]?.attributes, {
    "exception.type": "Error",
  });
  // Text imitating Everything's own status, set by a library or carried by a thrown error.
  for (const name of ["GET", "lookup"]) {
    const imitating = exported.spans.find((span) => span.name === name);
    assert.deepEqual(imitating?.status, { code: SpanStatusCode.ERROR }, name);
    assert.equal(imitating?.attributes[attribute.textWithheld], true, name);
  }

  // A tool the model made up, named like a key, is recorded without the key.
  const [tool] = spansNamed(exported, telemetrySpans.tool);
  assert.equal(tool?.attributes[attribute.tool], "[redacted]");
  assert.equal(tool?.attributes[attribute.outcome], "failure");

  const [requestFailed] = eventsNamed(exported, telemetryEvents.requestFailed);
  assert.equal(requestFailed?.attributes[attribute.code], "INTERNAL_ERROR");
  assert.equal(requestFailed?.attributes[attribute.errorType], "Error");
  assert.match(String(requestFailed?.attributes[attribute.stack]), /^at /);
  assert.equal(requestFailed?.attributes[attribute.textWithheld], true);

  const [warning] = eventsNamed(exported, telemetryEvents.warning);
  assert.equal(warning?.body, "Fleet failed; Everything will retry.");
  assert.equal(warning?.attributes[attribute.textWithheld], true);
});
