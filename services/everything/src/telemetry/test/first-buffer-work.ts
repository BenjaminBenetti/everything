import type { TestContext } from "node:test";
import {
  context as otel,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { sendMessageToolName } from "../../runtime/model/message-delivery.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import { shapeQueryStatement } from "../service/database-statement-processor.js";
import { startTelemetrySpan } from "../service/telemetry-recorder.js";
import { failure, reply, settled, teammate } from "./runtime-fixtures.js";

/**
 * Deliberately fake credential-like values, each marked REVIEWFAKE, written the ways telemetry
 * captures them: in the user's message, in tool arguments and a tool name a model made up, in an SQL
 * statement and a value a library might record beside it, in a dependency's URL and headers, and in
 * error text. None may be held in any telemetry buffer, recorded content or not.
 */
export const canaries = {
  messageAssignment: "REVIEWFAKEfbmsg01",
  messagePathKey: "REVIEWFAKEfbpath02",
  toolField: "REVIEWFAKEfbarg03",
  toolNested: "REVIEWFAKEfbarg04",
  toolName: "REVIEWFAKEfbtool05",
  sqlLiteral: "REVIEWFAKEfbsql06",
  sqlIdentifier: "REVIEWFAKEfbdq07",
  boundValue: "REVIEWFAKEfbbind08",
  urlQuery: "REVIEWFAKEfburl09",
  header: "REVIEWFAKEfbhdr10",
  errorText: "REVIEWFAKEfberr11",
  exception: "REVIEWFAKEfbexc12",
  providerError: "REVIEWFAKEfbprov13",
} as const;

/** Ordinary private words, in no credential shape, that only withholding content or error text keeps out. */
export const privateWords = {
  message: "the private launch is on a Tuesday",
  error: "the failing patient record",
} as const;

/** The made-up tool name, shaped like a provider key. */
export const madeUpToolName = `sk-proj-${canaries.toolName}abcdefgh`;

/** The text the send-message tool is given, which it must receive unchanged. */
export const deliveredText = "Here is the plan for the launch.";

/** A credential-shaped value, quoted inside a quoted SQL identifier with SQL's doubled quotes. */
const quotedCredential = `"password=""${canaries.sqlIdentifier}"""`;

/** The SQL statement as the application runs it; its shape alone may be recorded. */
export const statement = `SELECT 1 AS ${quotedCredential} FROM visits WHERE note = '${canaries.sqlLiteral}' AND id = $1`;

/** Its shape, as recorded with content. */
export const statementShape =
  'SELECT ? AS "password=[redacted]" FROM visits WHERE note = ? AND id = $1';

/** The span names the work records, so a test can tell every one reached each buffer. */
export const workSpans = {
  turn: "teammate.turn",
  tool: "teammate.tool",
  query: "pg.query:SELECT everything",
  read: "GET /v1/agents/:agentId/visits",
  dependency: "GET",
} as const;

/**
 * Record, through the process's real telemetry pipeline, a teammate turn on a real Pi session that
 * calls tools and then fails at its provider, database queries shaped as the PostgreSQL hook shapes
 * them, and a read request whose spans the read-request filter holds until it ends. Returns what the
 * send-message tool received and the tool arguments as the model gave them.
 */
export async function recordCanaryWork(context: TestContext) {
  const message = `Plan: ${privateWords.message}. Call https://gateway.test/v1/sk%2Dproj%2D${canaries.messagePathKey}abcdef/messages with api%5Fkey%3D${canaries.messageAssignment}`;
  const inspected = {
    "api%5Fkey": canaries.toolField,
    nested: { note: `token%3D${canaries.toolNested}` },
    path: "/v1/visits",
  };
  const given = structuredClone(inspected);
  const { runtime, deliveries } = await teammate(context, ({ attempt }) => {
    if (attempt === 1)
      return reply("", { name: "inspect_request", input: inspected });
    if (attempt === 2) return reply("", { name: madeUpToolName, input: {} });
    if (attempt === 3)
      return reply("", {
        name: sendMessageToolName,
        input: { text: deliveredText },
      });
    return failure(400, {
      error: {
        message: `Invalid request: password=${canaries.providerError} was rejected while reading ${privateWords.error}`,
        type: "invalid_request_error",
      },
    });
  });
  runtime.start(message);
  await settled(runtime);

  // Queries as the PostgreSQL instrumentation records them: the hook shapes the statement as the
  // query starts, and a library may record a parameter value beside it, which is never kept.
  const hooked = startTelemetrySpan(workSpans.query, {
    kind: SpanKind.CLIENT,
    scope: { ownerId: "owner-a" },
    attributes: {
      "db.system.name": "postgresql",
      "db.query.parameter.0": canaries.boundValue,
    },
  });
  shapeQueryStatement(hooked.span, statement);
  hooked.span.end();
  // A statement that reached its span other than through the hook, shaped as the span ends.
  const ended = startTelemetrySpan(workSpans.query, {
    kind: SpanKind.CLIENT,
    scope: { ownerId: "owner-a" },
    attributes: {
      "db.system": "postgresql",
      [attribute.dbStatement]: statement,
    },
  });
  ended.span.end();

  // A read request, whose spans are held until it ends, with a dependency call that failed.
  const tracer = trace.getTracer("first-buffer-work");
  const read = tracer.startSpan(workSpans.read, {
    kind: SpanKind.SERVER,
    root: true,
    attributes: {
      [attribute.httpMethod]: "GET",
      [attribute.httpRoute]: "/v1/agents/:agentId/visits",
    },
  });
  otel.with(trace.setSpan(otel.active(), read), () => {
    const call = tracer.startSpan(workSpans.dependency, {
      kind: SpanKind.CLIENT,
      attributes: {
        [attribute.urlFull]: `https://dependency.test/resource?api_key=${canaries.urlQuery}`,
        [attribute.serverAddress]: "dependency.test",
        "http.request.header.authorization": `Bearer ${canaries.header}`,
      },
    });
    call.recordException(
      new Error(
        `Dependency said token=${canaries.exception}: ${privateWords.error}`,
      ),
    );
    call.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Lookup failed with password=${canaries.errorText} for ${privateWords.error}`,
    });
    call.end();
  });
  read.setAttribute(attribute.httpStatus, 500);
  read.setStatus({ code: SpanStatusCode.ERROR });
  read.end();
  return { deliveries, inspected, given };
}

/** A canary for a deliberately raw record, which only the final exporter would hide. */
export const rawCanary = "REVIEWFAKEfbraw14";

/**
 * A span recorded outside the process's telemetry, as raw as the SDK makes one, carrying the raw
 * canary in a header attribute and a key-shaped tool name, for a test to hand to a buffer directly.
 */
export function rawSyntheticSpan(): ReadableSpan {
  const span = new TracerProvider()
    .getTracer("first-buffer-raw")
    .startSpan("raw.synthetic", {
      attributes: {
        "http.request.header.authorization": `Bearer ${rawCanary}`,
        [attribute.tool]: `sk-proj-${rawCanary}abcdefgh`,
      },
    });
  span.end();
  return span as unknown as ReadableSpan;
}

/** A canary for a record made after the bypassed processor is restored. */
export const restoredCanary = "REVIEWFAKEfbraw15";

/**
 * End a span through the process's telemetry carrying `canary` in a header attribute and a
 * key-shaped tool name, as a library and a model might record them.
 */
export function recordSyntheticSpan(name: string, canary: string): void {
  trace
    .getTracer("first-buffer-work")
    .startSpan(name, {
      attributes: {
        "http.request.header.authorization": `Bearer ${canary}`,
        [attribute.tool]: `sk-proj-${canary}abcdefgh`,
      },
    })
    .end();
}
