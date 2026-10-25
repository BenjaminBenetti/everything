import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  LoggerProvider,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  TracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import {
  exportableLogRecord,
  exportableSpan,
} from "../adapter/redacting-exporters.js";
import {
  RedactingLogRecordProcessor,
  RedactingSpanProcessor,
} from "../adapter/redacting-processors.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import { ExportHealth } from "../service/export-health.js";
import { messagePreview } from "../service/message-preview.js";
import { sqlStatementPreview } from "../service/sql-statement.js";
import {
  exportableAttributes,
  type ExportPolicy,
} from "../service/telemetry-allowlist.js";
import { redactText } from "../service/telemetry-redactor.js";
import { toolArgumentsPreview } from "../service/tool-arguments-preview.js";

/**
 * Values that only begin with the redaction marker, as if they had been made safe already. Each
 * credential-like suffix here is a deliberately fake, short canary marked REVIEWFAKE, in no shape
 * the redactor recognizes on its own, so only the assignment or header it is written in gives it
 * away. A marker at the start of a value proves nothing about what follows it.
 */

/** Recorded with content, as installations do by default, and with both withheld. */
const recorded: ExportPolicy = { includeErrorText: true, includeContent: true };
const withheld: ExportPolicy = {
  includeErrorText: false,
  includeContent: false,
};

const marker = "[redacted]";

/** The `index`th short fake suffix. */
const fake = (index: number) => `REVIEWFAKEmk${String(index).padStart(2, "0")}`;

/** Whether `text` holds any of the fake suffixes. */
const leaks = (text: string) => /REVIEWFAKEmk\d\d/.test(text);

// ===========================================
// The generic redactor
// ===========================================

test("C2: a credential value that only begins with the marker is redacted whole, in every assignment and header form", () => {
  const cases = [
    `password=${marker}${fake(1)}`,
    `password = "${marker}${fake(2)}" and more`,
    `secret: '${marker}${fake(3)}'`,
    `{"password":"${marker}${fake(4)}","user":"kiwi"}`,
    `{\\"api_key\\":\\"${marker}${fake(5)}\\"}`,
    `Authorization: Bearer ${marker}${fake(6)}`,
    `Cookie: ${marker}; session=${fake(7)}`,
    `Set-Cookie: ${marker}${fake(8)}`,
    `token=${marker}-${fake(9)}`,
    `access_token=${marker}${marker}${fake(10)}`,
    `the call failed: client_secret = ${marker}${fake(11)}, retry later`,
  ];
  for (const text of cases) {
    const safe = redactText(text, 400);
    assert.ok(!leaks(safe), `${text} → ${safe}`);
    assert.ok(safe.includes(marker), safe);
    assert.ok(!/\]\w/.test(safe), `no bracket is left before a tail: ${safe}`);
    assert.equal(
      redactText(safe, 400),
      safe,
      "redacting again changes nothing",
    );
  }
  assert.equal(
    redactText(`password=${marker}${fake(1)}`, 400),
    `password=${marker}`,
  );
  assert.equal(
    redactText(`password = "${marker}${fake(2)}" and more`, 400),
    `password = ${marker} and more`,
  );
  assert.equal(
    redactText(`{"password":"${marker}${fake(4)}","user":"kiwi"}`, 400),
    `{"password":${marker},"user":"kiwi"}`,
  );
});

test("C2: exact placeholders, and text that only mentions the marker, are kept exactly as written", () => {
  for (const text of [
    `password=${marker}`,
    `password = "${marker}"`,
    `secret: '${marker}'`,
    `{"password":"${marker}","user":"kiwi"}`,
    `{\\"password\\":\\"${marker}\\"}`,
    `password=${marker}, user=kiwi`,
    `password=${marker}…[truncated]`,
    `Cookie: ${marker}`,
    `Set-Cookie: ${marker}`,
    `token ${marker}`,
    `the note says ${marker} before the plan`,
    `see https://gateway.test/v1/${marker}/messages`,
  ])
    assert.equal(redactText(text, 400), text);
});

test("C2: percent-encoded, a marker-prefixed value is redacted too, within three decoding passes", () => {
  for (const text of [
    `password%3D%5Bredacted%5D${fake(12)}`,
    `api%5Fkey%3D%5Bredacted%5D${fake(13)}`,
    `password%253D%255Bredacted%255D${fake(14)}`,
  ]) {
    assert.ok(!leaks(redactText(text, 400)), text);
    assert.ok(!leaks(messagePreview(`Use ${text} now`).text), text);
  }
});

// ===========================================
// Previews and SQL shapes
// ===========================================

test("C2: message previews, tool arguments, and SQL quoted identifiers never keep a marker-prefixed value", () => {
  assert.ok(
    !leaks(messagePreview(`Note password="${marker}${fake(15)}" ok`).text),
  );
  const argumentsPreview = toolArgumentsPreview({
    note: `password=${marker}${fake(16)}`,
    nested: { header: `Cookie: ${marker}${fake(17)}` },
  }).text;
  assert.ok(!leaks(argumentsPreview), argumentsPreview);
  JSON.parse(argumentsPreview);
  for (const statement of [
    `SELECT 1 AS "password=""${marker}${fake(18)}""" FROM t WHERE id = $1`,
    `SELECT 1 AS "token=${marker}${fake(19)}" FROM t`,
    `SELECT 1 AS "note ""kept"" secret='${marker}${fake(20)}'" FROM t`,
  ]) {
    const shape = sqlStatementPreview(statement).text;
    assert.ok(!leaks(shape), shape);
    assert.match(shape, /^SELECT \? AS "(?:[^"]|"")*" FROM t/);
    assert.equal(sqlStatementPreview(shape).text, shape, "shaping again");
  }
  // A quoted identifier that holds exactly the placeholder is kept as it is.
  const exact = `SELECT ? AS "password=""${marker}""" FROM t`;
  assert.equal(sqlStatementPreview(exact).text, exact);
});

// ===========================================
// Identifier attributes
// ===========================================

test("C2: identifier attributes holding a marker-prefixed assignment never keep its value, while safe identifiers and markers survive a second pass", () => {
  const keys = [
    "error.type",
    "exception.type",
    attribute.tool,
    "db.namespace",
    attribute.serverAddress,
  ];
  for (const policy of [recorded, withheld])
    for (const key of keys)
      for (const value of [
        `password:${marker}${fake(21)}`,
        `token:${marker}-${fake(22)}`,
        `${marker}${fake(23)}`,
        `x.${marker}${fake(24)}`,
      ]) {
        const once = exportableAttributes({ [key]: value }, policy);
        assert.ok(!leaks(JSON.stringify(once)), `${key}: ${value}`);
        assert.deepEqual(exportableAttributes(once, policy), once);
      }
  const kept = {
    "error.type": "Error",
    "exception.type": "AbortError",
    [attribute.tool]: "send_message",
    "db.namespace": "everything",
    [attribute.serverAddress]: "api.example.test",
  };
  for (const policy of [recorded, withheld]) {
    assert.deepEqual(exportableAttributes(kept, policy), kept);
    // Identifiers already made safe keep their markers, as complete parts.
    for (const value of [
      marker,
      `tool-${marker}`,
      `a.${marker}/b`,
      `password:${marker}`,
    ]) {
      const once = exportableAttributes({ "error.type": value }, policy);
      assert.equal(once["error.type"], value, value);
      assert.deepEqual(exportableAttributes(once, policy), once);
    }
  }
});

// ===========================================
// Before any buffer, and at export
// ===========================================

test("C2: a span's and an event's marker-prefixed values are redacted before any buffer holds them, and at export, recorded or withheld", () => {
  for (const policy of [recorded, withheld]) {
    let held: ReadableSpan | undefined;
    const spans: SpanProcessor = {
      onStart() {},
      onEnd(safe) {
        held = safe;
      },
      async forceFlush() {},
      async shutdown() {},
    };
    const span = new TracerProvider().getTracer("review-c2").startSpan("GET", {
      attributes: { "error.type": `password:${marker}${fake(25)}` },
    });
    span.recordException(
      new Error(`Lookup said secret: '${marker}${fake(26)}'`),
    );
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Lookup failed with password="${marker}${fake(27)}"`,
    });
    span.end();
    new RedactingSpanProcessor(spans, new ExportHealth(), policy).onEnd(
      span as unknown as ReadableSpan,
    );
    assert.ok(held, "the span was passed on");
    const heldText = JSON.stringify({
      attributes: held.attributes,
      status: held.status,
      events: held.events,
    });
    assert.ok(!leaks(heldText), heldText);
    const shipped = exportableSpan(held, policy);
    assert.ok(
      !leaks(
        JSON.stringify({
          attributes: shipped.attributes,
          status: shipped.status,
          events: shipped.events,
        }),
      ),
    );

    let queued: ReadableLogRecord | undefined;
    const logs: LogRecordProcessor = {
      onEmit(record) {
        queued = record;
      },
      async forceFlush() {},
      async shutdown() {},
    };
    new LoggerProvider({
      processors: [
        new RedactingLogRecordProcessor(logs, new ExportHealth(), policy),
      ],
    })
      .getLogger("review-c2")
      .emit({
        body: "Model request failed",
        attributes: {
          [attribute.message]: `Invalid request: token=${marker}${fake(28)}`,
          "error.type": `password:${marker}${fake(29)}`,
        },
      });
    assert.ok(queued, "the event was passed on");
    const queuedText = JSON.stringify({
      body: queued.body,
      attributes: queued.attributes,
    });
    assert.ok(!leaks(queuedText), queuedText);
    const exported = exportableLogRecord(queued, policy);
    assert.ok(
      !leaks(
        JSON.stringify({
          body: exported.body,
          attributes: exported.attributes,
        }),
      ),
    );
  }
});
