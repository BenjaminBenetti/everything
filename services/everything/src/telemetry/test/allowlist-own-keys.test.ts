import assert from "node:assert/strict";
import { test } from "node:test";
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
import {
  exportableAttributes,
  type ExportPolicy,
} from "../service/telemetry-allowlist.js";
import { redactText } from "../service/telemetry-redactor.js";

/**
 * Attribute keys that name an inherited property of an ordinary object, such as `constructor`, are
 * no allowlisted attribute and must be dropped, never resolved to an inherited function and called.
 * Each credential-like value here is a deliberately fake, short canary marked REVIEWFAKE, written
 * as a plain `token=` assignment, so only the allowlist decides whether it is kept.
 */

/** Recorded with content, as installations do by default, and with both withheld. */
const policies: readonly ExportPolicy[] = [
  { includeErrorText: true, includeContent: true },
  { includeErrorText: false, includeContent: false },
];

/** Whether `text` holds any of these fake canaries. */
const leaks = (text: string) => /REVIEWFAKEc3/.test(text);

/** Known attributes that every policy keeps, beside the unknown ones. */
const known = {
  [attribute.ownerId]: "owner-a",
  [attribute.httpRoute]: "/v1/agents/:agentId/visits",
  "error.type": "Error",
};

// ===========================================
// The allowlist
// ===========================================

/** What the allowlist does with `key` holding `value`: drops it, keeps something, or throws. */
function outcome(key: string, value: unknown, policy: ExportPolicy): string {
  try {
    const safe = exportableAttributes(
      Object.fromEntries([[key, value]]),
      policy,
    );
    if (!Object.hasOwn(safe, key)) return "dropped";
    const kept = safe[key] as unknown;
    if (kept === value) return "kept the same value";
    if (typeof kept === "object" && kept !== null)
      return `kept a ${Object.prototype.toString.call(kept)}`;
    return `kept a ${typeof kept}`;
  } catch (error) {
    return `threw ${(error as Error).name}`;
  }
}

test("C3: an unknown attribute named constructor is dropped, as a string or a list, recorded or withheld", (context) => {
  for (const [name, value] of [
    ["string", "token=REVIEWFAKEc3a1"],
    ["list", ["token=REVIEWFAKEc3a2", "plain"]],
  ] as const)
    context.diagnostic(
      `constructor as a ${name}: ${policies.map((policy) => outcome("constructor", value, policy)).join(" / ")} (recorded / withheld)`,
    );
  for (const policy of policies)
    for (const value of [
      "token=REVIEWFAKEc3a1",
      ["token=REVIEWFAKEc3a2", "plain"],
    ]) {
      const attributes = { ...known, constructor: value };
      const given = structuredClone(attributes);
      const safe = exportableAttributes(attributes, policy);
      assert.ok(!Object.hasOwn(safe, "constructor"), JSON.stringify(safe));
      assert.ok(!leaks(JSON.stringify(safe)), JSON.stringify(safe));
      assert.deepEqual(safe, known, "known attributes are kept as they were");
      assert.deepEqual(attributes, given, "the attributes given are unchanged");
    }
});

test("C3: other names an ordinary object inherits, and an own __proto__, are dropped without throwing", (context) => {
  const inherited = [
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__lookupGetter__",
  ];
  for (const key of [...inherited, "__proto__"])
    context.diagnostic(
      `${key}: ${policies.map((policy) => outcome(key, `token=REVIEWFAKEc3b-${key}`, policy)).join(" / ")} (recorded / withheld)`,
    );
  for (const policy of policies) {
    for (const key of inherited) {
      const safe = exportableAttributes(
        { ...known, [key]: `token=REVIEWFAKEc3b-${key}` },
        policy,
      );
      assert.deepEqual(safe, known, key);
    }
    const ownProto = Object.fromEntries([
      ["__proto__", "token=REVIEWFAKEc3b-proto"],
      ...Object.entries(known),
    ]);
    assert.ok(
      Object.hasOwn(ownProto, "__proto__"),
      "the fixture is an own key",
    );
    const safe = exportableAttributes(ownProto, policy);
    assert.deepEqual(safe, known);
    assert.equal(Object.getPrototypeOf(safe), Object.prototype);
  }
});

// ===========================================
// Before any buffer, and at export
// ===========================================

test("C3: a real span's and event's constructor attributes, and a real log record's, never reach the first buffer or the export, recorded or withheld", () => {
  for (const policy of policies) {
    let held: ReadableSpan | undefined;
    const spans: SpanProcessor = {
      onStart() {},
      onEnd(safe) {
        held = safe;
      },
      async forceFlush() {},
      async shutdown() {},
    };
    const span = new TracerProvider()
      .getTracer("review-c3")
      .startSpan("GET /v1/agents/:agentId/visits", {
        attributes: { ...known, constructor: "token=REVIEWFAKEc3c1" },
      });
    span.addEvent("exception", {
      "exception.type": "Error",
      constructor: ["token=REVIEWFAKEc3c2"],
    });
    span.end();
    new RedactingSpanProcessor(spans, new ExportHealth(), policy).onEnd(
      span as unknown as ReadableSpan,
    );
    assert.ok(held, "the span was passed on");
    assert.ok(!Object.hasOwn(held.attributes, "constructor"));
    assert.ok(!Object.hasOwn(held.events[0]!.attributes!, "constructor"));
    assert.deepEqual(held.attributes, known);
    assert.deepEqual(held.events[0]!.attributes, { "exception.type": "Error" });
    const shipped = exportableSpan(held, policy);
    const text = JSON.stringify({
      held: { attributes: held.attributes, events: held.events },
      shipped: { attributes: shipped.attributes, events: shipped.events },
    });
    assert.ok(!leaks(text), text);
    // The SDK's own span still holds what it was given; only telemetry's copy changed.
    const raw = span as unknown as ReadableSpan;
    assert.equal(raw.attributes.constructor, "token=REVIEWFAKEc3c1");

    let queued: ReadableLogRecord | undefined;
    const logs: LogRecordProcessor = {
      onEmit(record) {
        queued = record;
      },
      async forceFlush() {},
      async shutdown() {},
    };
    const logAttributes = {
      [attribute.event]: "http.request.failed",
      constructor: "token=REVIEWFAKEc3c3",
    };
    new LoggerProvider({
      processors: [
        new RedactingLogRecordProcessor(logs, new ExportHealth(), policy),
      ],
    })
      .getLogger("review-c3")
      .emit({ body: "Request failed", attributes: logAttributes });
    assert.ok(queued, "the event was passed on");
    assert.ok(!Object.hasOwn(queued.attributes, "constructor"));
    assert.deepEqual(queued.attributes, {
      [attribute.event]: "http.request.failed",
    });
    const exported = exportableLogRecord(queued, policy);
    assert.ok(
      !leaks(
        JSON.stringify({
          queued: queued.attributes,
          exported: exported.attributes,
        }),
      ),
    );
    assert.equal(logAttributes.constructor, "token=REVIEWFAKEc3c3");
  }
});

// ===========================================
// The known no-space cookie form
// ===========================================

test("C2 (known form): a cookie header written without a space, whose value begins with the marker, is redacted whole; exactly the marker is kept", () => {
  for (const text of [
    "Cookie:[redacted]REVIEWFAKEc3d1",
    "Cookie:[redacted]; session=REVIEWFAKEc3d2",
    "Set-Cookie:[redacted]REVIEWFAKEc3d3; Path=/",
  ]) {
    const safe = redactText(text, 400);
    assert.ok(!leaks(safe), `${text} → ${safe}`);
    assert.ok(!/\]\w/.test(safe), `no bracket is left before a tail: ${safe}`);
    assert.equal(
      redactText(safe, 400),
      safe,
      "redacting again changes nothing",
    );
  }
  for (const text of ["Cookie:[redacted]", "Set-Cookie:[redacted]"])
    assert.equal(redactText(text, 400), text);
});
