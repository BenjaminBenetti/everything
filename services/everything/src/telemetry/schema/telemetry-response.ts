import { Type } from "typebox";
import {
  telemetryLimits,
  telemetryOutcomes,
  telemetrySeverities,
  telemetrySources,
  telemetryTypes,
} from "@everything/telemetry-contracts";

/** A string or null. */
const nullableString = Type.Union([Type.String(), Type.Null()]);

/** A labelled, redacted fact about a record. */
const telemetryDetail = Type.Object({
  key: Type.String(),
  label: Type.String(),
  value: Type.String(),
});

/** Fields every event and span list entry has. */
const summaryFields = {
  id: Type.String(),
  source: Type.Union(telemetrySources.map((value) => Type.Literal(value))),
  time: Type.String({ format: "date-time" }),
  type: Type.Union(telemetryTypes.map(({ id }) => Type.Literal(id))),
  severity: Type.Union(telemetrySeverities.map((value) => Type.Literal(value))),
  outcome: Type.Union([
    ...telemetryOutcomes.map((value) => Type.Literal(value)),
    Type.Null(),
  ]),
  name: Type.String(),
  title: Type.String({
    description: "A summary written by Everything, never raw provider text.",
  }),
  category: nullableString,
  code: nullableString,
  httpStatus: Type.Union([Type.Integer(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  agentId: nullableString,
  provider: nullableString,
  model: nullableString,
  traceId: nullableString,
  spanId: nullableString,
};

/** Spans add their place in the trace, status, and events. */
const spanFields = {
  ...summaryFields,
  parentSpanId: nullableString,
  kind: Type.Union(
    ["server", "client", "internal", "producer", "consumer"].map((value) =>
      Type.Literal(value),
    ),
  ),
  startTime: Type.String({ format: "date-time" }),
  statusMessage: nullableString,
  textWithheld: Type.Boolean(),
  details: Type.Array(telemetryDetail),
  events: Type.Array(
    Type.Object({
      name: Type.String(),
      time: Type.String({ format: "date-time" }),
      details: Type.Array(telemetryDetail),
    }),
  ),
};

/** An event or span in a list. */
const telemetryRecordResponse = Type.Object(summaryFields);

/** Whether telemetry is on and answering, and this process's export health. */
export const telemetryStatusResponse = Type.Object({
  state: Type.Union([
    Type.Literal("disabled"),
    Type.Literal("available"),
    Type.Literal("unavailable"),
  ]),
  retentionDays: Type.Integer(),
  errorText: Type.Union([Type.Literal("withheld"), Type.Literal("included")]),
  export: Type.Union([
    Type.Object({
      lastSuccessAt: Type.Union([
        Type.String({ format: "date-time" }),
        Type.Null(),
      ]),
      lastFailureAt: Type.Union([
        Type.String({ format: "date-time" }),
        Type.Null(),
      ]),
      failedBatches: Type.Integer({ minimum: 0 }),
      droppedRecords: Type.Integer({ minimum: 0 }),
    }),
    Type.Null(),
  ]),
});

/** A page of `records`, newest first, with the searched range. */
function pageOf<T extends ReturnType<typeof Type.Object>>(record: T) {
  return Type.Object({
    records: Type.Array(record, { maxItems: telemetryLimits.maxPageSize }),
    nextCursor: nullableString,
    from: Type.String({ format: "date-time" }),
    to: Type.String({ format: "date-time" }),
  });
}

/** A page of the owner's events. */
export const telemetryEventPageResponse = pageOf(telemetryRecordResponse);

/** A page of the owner's spans. */
export const telemetrySpanPageResponse = pageOf(Type.Object(spanFields));

/** One event with its diagnosis. */
export const telemetryEventResponse = Type.Object({
  ...summaryFields,
  message: nullableString,
  textWithheld: Type.Boolean(),
  requestId: nullableString,
  sessionId: nullableString,
  runId: nullableString,
  retryable: Type.Union([Type.Boolean(), Type.Null()]),
  details: Type.Array(telemetryDetail),
});

/** The owner's spans and events in one trace. */
export const telemetryTraceResponse = Type.Object({
  traceId: Type.String(),
  spans: Type.Array(Type.Object(spanFields), {
    maxItems: telemetryLimits.traceSpanLimit,
  }),
  events: Type.Array(telemetryRecordResponse, {
    maxItems: telemetryLimits.traceEventLimit,
  }),
  truncated: Type.Boolean(),
});
