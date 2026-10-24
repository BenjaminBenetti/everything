import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { exportableSpan } from "../adapter/redacting-exporters.js";
import { modelFailureCategories } from "../model/model-failure.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import { telemetryStatuses } from "../model/telemetry-statuses.js";
import {
  exportableAttributes,
  type ExportPolicy,
} from "../service/telemetry-allowlist.js";

/** Both error-text settings; credentials are redacted under each. */
const policies: readonly ExportPolicy[] = [
  { includeErrorText: false },
  { includeErrorText: true },
];

/** A synthetic key in a shape the redactor recognizes. */
const key = "sk-proj-abcdefghijklmnopqrstuvwx";

/** Spans made by a tracer of their own, as instrumented libraries' are, for the exporter's view. */
const tracer = new TracerProvider().getTracer("export-boundary-test");

/** An ended span with `status`, as the exporter receives it. */
function ended(status: { code: SpanStatusCode; message?: string }) {
  const span = tracer.startSpan("pg.query:SELECT everything", {
    kind: SpanKind.CLIENT,
  });
  span.setStatus(status);
  span.end();
  return span as unknown as ReadableSpan;
}

for (const policy of policies) {
  const mode = policy.includeErrorText ? "recorded" : "withheld";

  test(`identifiers keep their meaning but never a credential, with error text ${mode}`, () => {
    const exported = exportableAttributes(
      {
        [attribute.tool]: key,
        [attribute.reason]: key,
        "error.type": key,
        "exception.type": key,
        [attribute.serverAddress]: `${key}.gateway.example`,
        "net.peer.name": `${key}.gateway.example`,
        "db.name": key,
        [attribute.httpMethod]: key,
      },
      policy,
    );
    assert.ok(!JSON.stringify(exported).includes(key), "no key is exported");
    assert.equal(exported[attribute.tool], "[redacted]");
    assert.equal(exported[attribute.reason], "[redacted]");
    assert.equal(exported["error.type"], "[redacted]");
    assert.equal(exported["exception.type"], "[redacted]");
    assert.equal(
      exported[attribute.serverAddress],
      "[redacted].gateway.example",
    );
    assert.deepEqual(
      exportableAttributes(
        {
          [attribute.tool]: "send_message",
          [attribute.reason]: "threshold",
          "error.type": "ECONNREFUSED",
          "exception.type": "AbortError",
          [attribute.serverAddress]: "api.anthropic.com",
          "server.port": 443,
          "db.name": "everything",
          [attribute.httpMethod]: "POST",
          [attribute.httpStatus]: 429,
          [attribute.requestId]: "req_011CUrateLimit",
          [attribute.retryable]: true,
        },
        policy,
      ),
      {
        [attribute.tool]: "send_message",
        [attribute.reason]: "threshold",
        "error.type": "ECONNREFUSED",
        "exception.type": "AbortError",
        [attribute.serverAddress]: "api.anthropic.com",
        "server.port": 443,
        "db.name": "everything",
        [attribute.httpMethod]: "POST",
        [attribute.httpStatus]: 429,
        [attribute.requestId]: "req_011CUrateLimit",
        [attribute.retryable]: true,
      },
      "ordinary identifiers, numbers, and booleans are unchanged",
    );
  });

  test(`a key after an encoded ? or # in a path is redacted in every URL attribute, with error text ${mode}`, () => {
    for (const [separator, shown] of [
      ["%3F", "%3F"],
      ["%23", "%23"],
      ["%253F", "%3F"],
      ["%2523", "%23"],
      ["%25253F", "%3F"],
    ] as const) {
      for (const suffix of ["", "/x", "/messages"]) {
        const path = `/v1/${separator}${key}${suffix}`;
        const exported = exportableAttributes(
          {
            [attribute.urlFull]: `https://gateway.example${path}?debug=1#top`,
            "http.url": `https://gateway.example${path}`,
            [attribute.urlPath]: path,
            "http.target": `${path}?debug=1`,
          },
          policy,
        );
        const expected = `/v1/${shown}[redacted]${suffix}`;
        assert.deepEqual(
          exported,
          {
            [attribute.urlFull]: `https://gateway.example${expected}`,
            "http.url": `https://gateway.example${expected}`,
            [attribute.urlPath]: expected,
            "http.target": expected,
          },
          path,
        );
      }
    }
    // A real query string or fragment is dropped, key and all.
    assert.deepEqual(
      exportableAttributes(
        {
          [attribute.urlFull]: `https://gateway.example/v1/?${key}`,
          "http.url": `https://gateway.example/v1/#${key}`,
          "http.target": `/v1/?${key}`,
        },
        policy,
      ),
      {
        [attribute.urlFull]: "https://gateway.example/v1/",
        "http.url": "https://gateway.example/v1/",
        "http.target": "/v1/",
      },
    );
  });
}

test("by default only Everything's own fixed status messages are kept; text that imitates one is withheld and marked", () => {
  for (const category of modelFailureCategories) {
    const view = exportableSpan(
      ended({
        code: SpanStatusCode.ERROR,
        message: telemetryStatuses.modelFailed(category),
      }),
    );
    assert.equal(
      view.status.message,
      `Model request failed: ${category}`,
      category,
    );
    assert.equal(view.attributes[attribute.textWithheld], undefined);
  }
  for (const fixed of [
    telemetryStatuses.compactionFailed,
    telemetryStatuses.httpFailed(429),
    telemetryStatuses.httpFailed(503),
  ])
    assert.equal(
      exportableSpan(ended({ code: SpanStatusCode.ERROR, message: fixed }))
        .status.message,
      fixed,
    );
  for (const imitation of [
    "Model request failed: payroll_moves_to_a_new_bank_in_march",
    "Model request failed: rate_limit because the launch is next Tuesday",
    "Model request failed: rate_limit\n",
    "model request failed: rate_limit",
    "Context compaction failed: the merger closes in March",
    "HTTP 999",
    "HTTP 4290",
    "HTTP 429 for the payroll export",
  ]) {
    const view = exportableSpan(
      ended({ code: SpanStatusCode.ERROR, message: imitation }),
    );
    assert.deepEqual(view.status, { code: SpanStatusCode.ERROR }, imitation);
    assert.equal(view.attributes[attribute.textWithheld], true, imitation);
  }
});

test("with error text recorded, any status message is kept, redacted and bounded", () => {
  const recorded: ExportPolicy = { includeErrorText: true };
  const view = exportableSpan(
    ended({
      code: SpanStatusCode.ERROR,
      message: `Model request failed: payroll_moves_to_a_new_bank_in_march api_key=${key} ${"more ".repeat(200)}`,
    }),
    recorded,
  );
  const message = String(view.status.message);
  assert.ok(
    message.startsWith(
      "Model request failed: payroll_moves_to_a_new_bank_in_march api_key=[redacted]",
    ),
  );
  assert.ok(message.length <= 400);
  assert.ok(!message.includes(key));
  assert.equal(view.attributes[attribute.textWithheld], undefined);
});
