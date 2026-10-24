import {
  telemetryLimits,
  telemetryOutcomes,
  telemetrySeverities,
  telemetryTypes,
  type TelemetryDetail,
  type TelemetryEvent,
  type TelemetryPreview,
  type TelemetryRecordSummary,
  type TelemetrySeverity,
  type TelemetrySpan,
  type TelemetrySpanEvent,
} from "@everything/telemetry-contracts";
import type { TelemetryRow } from "../interface/telemetry-search.js";
import {
  telemetryAttributes as attribute,
  telemetryColumn,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import { truncate, truncationMarker } from "../service/telemetry-redactor.js";
import { utf8Head, utf8Length } from "../service/text-budget.js";

/** Longest value of any field returned to the browser. */
const valueLimit = 1_200;

/** Most events listed for one span. */
const spanEventLimit = 32;

/** A detail's column and label. */
type DetailSpec = readonly [column: string, label: string];

/** Diagnostic facts shown for an event, in display order. */
const eventDetails: readonly DetailSpec[] = [
  [telemetryColumn(attribute.errorType), "Error type"],
  [telemetryColumn(attribute.api), "Provider API"],
  [telemetryColumn(attribute.stopReason), "Stop reason"],
  [telemetryColumn(attribute.attempts), "Attempts"],
  [telemetryColumn(attribute.retryAfter), "Retry after"],
  [telemetryColumn(attribute.speed), "Requested speed"],
  [telemetryColumn(attribute.reason), "Reason"],
  [telemetryColumn(attribute.willRetry), "Will retry"],
  [telemetryColumn(attribute.httpMethod), "Method"],
  [telemetryColumn(attribute.httpRoute), "Route"],
  [telemetryColumn(attribute.sessionKind), "Session"],
  [telemetryColumn(attribute.parentSessionId), "Parent session"],
  [telemetryColumn(attribute.stack), "Stack"],
];

/** Facts shown for a span, in display order. */
const spanDetails: readonly DetailSpec[] = [
  [telemetryColumn(attribute.httpMethod), "Method"],
  ["http_method", "Method"],
  [telemetryColumn(attribute.httpRoute), "Route"],
  [telemetryColumn(attribute.serverAddress), "Host"],
  [telemetryColumn(attribute.urlPath), "Path"],
  ["db_system_name", "Database"],
  ["db_system", "Database"],
  ["db_operation_name", "Operation"],
  ["db_operation", "Operation"],
  ["db_collection_name", "Table"],
  ["db_sql_table", "Table"],
  [telemetryColumn(attribute.tool), "Tool"],
  [telemetryColumn(attribute.attempt), "Attempt"],
  [telemetryColumn(attribute.requestId), "Provider request ID"],
  [telemetryColumn(attribute.retryAfter), "Retry after"],
  [telemetryColumn(attribute.reason), "Reason"],
  [telemetryColumn(attribute.sessionKind), "Session"],
  [telemetryColumn(attribute.sessionId), "Session ID"],
  [telemetryColumn(attribute.runId), "Run ID"],
  ["error_type", "Error type"],
];

/** Longest stored links value parsed; a span keeps at most a few links, each about 150 bytes. */
const linksLimit = 4_096;

/** Most links read from one span, as many as the SDK keeps. */
const linkLimit = 8;

/** A W3C trace ID and span ID, lowercase hexadecimal. */
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;

/** OTLP span kinds by their stored number. */
const spanKinds: Readonly<Record<string, TelemetrySpan["kind"]>> = {
  "1": "internal",
  "2": "server",
  "3": "client",
  "4": "producer",
  "5": "consumer",
};

// ===========================================
// Records
// ===========================================

/** An event row as a list entry. */
export function eventSummary(row: TelemetryRow): TelemetryRecordSummary {
  return {
    ...common(row),
    id: text(row, telemetryColumn(attribute.eventId)) ?? "",
    source: "events",
    time: microsToIso(row._timestamp),
    type:
      oneOf(
        telemetryTypes.map(({ id }) => id),
        row[telemetryColumn(attribute.type)],
      ) ?? "log",
    name: text(row, telemetryColumn(attribute.event)) ?? "event",
    title: text(row, "body") ?? "Event",
    durationMs: null,
  };
}

/** An event row with its full diagnosis. */
export function eventDetail(row: TelemetryRow): TelemetryEvent {
  return {
    ...eventSummary(row),
    message: text(row, telemetryColumn(attribute.message)),
    textWithheld: flag(row, telemetryColumn(attribute.textWithheld)) === true,
    requestId: text(row, telemetryColumn(attribute.requestId)),
    sessionId: text(row, telemetryColumn(attribute.sessionId)),
    runId: text(row, telemetryColumn(attribute.runId)),
    retryable: flag(row, telemetryColumn(attribute.retryable)),
    details: details(row, eventDetails),
  };
}

/** A span row as a list entry and trace member. */
export function spanRecord(row: TelemetryRow): TelemetrySpan {
  const name = text(row, "operation_name") ?? "span";
  const kind = spanKinds[String(row.span_kind)] ?? "internal";
  const duration = Number(row.duration);
  return {
    ...common(row),
    id: text(row, "span_id") ?? "",
    source: "spans",
    time: microsToIso(row._timestamp),
    startTime: microsToIso(row._timestamp),
    type:
      oneOf(
        telemetryTypes.map(({ id }) => id),
        row[telemetryColumn(attribute.type)],
      ) ??
      (kind === "server" ? "http" : kind === "client" ? "dependency" : "turn"),
    name,
    title: spanTitle(row, name),
    durationMs: Number.isFinite(duration) ? Math.round(duration) / 1000 : null,
    kind,
    parentSpanId: text(row, "reference_parent_span_id"),
    statusMessage: text(row, "status_message"),
    textWithheld: flag(row, telemetryColumn(attribute.textWithheld)) === true,
    previews: spanPreviews(row),
    contentWithheld:
      flag(row, telemetryColumn(attribute.contentWithheld)) === true,
    details: details(row, spanDetails),
    events: spanEvents(row.events),
  };
}

/** A span the stored span names in its links, such as the request that started a teammate turn. */
export interface SpanLink {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * The spans a stored span's links name: canonical, non-zero IDs only, from a bounded value, so a
 * malformed or oversized value yields none rather than an error.
 */
export function spanLinks(row: TelemetryRow): SpanLink[] {
  const value = row.links;
  if (typeof value !== "string" || value.length > linksLimit) return [];
  let links: unknown;
  try {
    links = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(links)) return [];
  const result: SpanLink[] = [];
  for (const link of links.slice(0, linkLimit)) {
    const context =
      link && typeof link === "object"
        ? ((link as { context?: unknown }).context ?? link)
        : undefined;
    if (!context || typeof context !== "object") continue;
    const ids = context as Record<string, unknown>;
    const traceId = identifier(ids.traceId ?? ids.trace_id, traceIdPattern);
    const spanId = identifier(ids.spanId ?? ids.span_id, spanIdPattern);
    if (traceId && spanId) result.push({ traceId, spanId });
  }
  return result;
}

// ===========================================
// Shared fields
// ===========================================

/** Fields events and spans store under the same columns. */
function common(row: TelemetryRow) {
  const status = Number(row[telemetryColumn(attribute.httpStatus)]);
  const severity =
    oneOf(telemetrySeverities, row[telemetryColumn(attribute.severity)]) ??
    severityFromText(row.severity);
  return {
    severity,
    outcome: oneOf(telemetryOutcomes, row[telemetryColumn(attribute.outcome)]),
    category: text(row, telemetryColumn(attribute.category)),
    code: text(row, telemetryColumn(attribute.code)),
    httpStatus:
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    agentId: text(row, telemetryColumn(attribute.agentId)),
    provider: text(row, telemetryColumn(attribute.provider)),
    model: text(row, telemetryColumn(attribute.model)),
    traceId: identifier(row.trace_id, /^[0-9a-f]{32}$/),
    spanId: identifier(row.span_id, /^[0-9a-f]{16}$/),
  } satisfies Partial<TelemetryRecordSummary>;
}

/** A readable name for a span: Everything's own spans by purpose, libraries' by target. */
function spanTitle(row: TelemetryRow, name: string): string {
  const host = text(row, telemetryColumn(attribute.serverAddress));
  switch (name) {
    case telemetrySpans.turn:
      return "Teammate turn";
    case telemetrySpans.prompt:
      return "Model prompt";
    case telemetrySpans.compaction:
      return "Context compaction";
    case telemetrySpans.tool:
      return `Tool: ${text(row, telemetryColumn(attribute.tool)) ?? "unknown"}`;
    case telemetrySpans.providerRequest:
      return host ? `Provider request to ${host}` : "Provider request";
  }
  if (name.startsWith("pg.") || text(row, "db_system") === "postgresql")
    return `PostgreSQL ${text(row, "db_operation_name") ?? text(row, "db_operation") ?? "query"}`;
  if (host && /^[A-Z]+$/.test(name)) return `${name} ${host}`;
  return name;
}

// ===========================================
// Content previews
// ===========================================

/** The content previews a span row holds: a message, a tool call's arguments, or a statement. */
function spanPreviews(row: TelemetryRow): TelemetryPreview[] {
  const previews: TelemetryPreview[] = [];
  const message = previewText(row, telemetryColumn(attribute.messagePreview));
  if (message) {
    const length = Number(row[telemetryColumn(attribute.messageLength)]);
    previews.push({
      kind: "message",
      format: "text",
      value: message.value,
      truncated:
        message.cut ||
        flag(row, telemetryColumn(attribute.messageTruncated)) === true,
      originalLength:
        Number.isSafeInteger(length) && length >= 0 ? length : null,
    });
  }
  const args = previewText(row, telemetryColumn(attribute.toolArguments));
  if (args)
    previews.push({
      kind: "tool_arguments",
      format: isJson(args.value) ? "json" : "text",
      value: args.value,
      truncated:
        args.cut ||
        flag(row, telemetryColumn(attribute.toolArgumentsTruncated)) === true,
      originalLength: null,
    });
  const statement =
    previewText(row, telemetryColumn(attribute.dbQueryText)) ??
    previewText(row, telemetryColumn(attribute.dbStatement));
  if (statement)
    previews.push({
      kind: "sql",
      format: "sql",
      value: statement.value,
      truncated: statement.cut || statement.value.endsWith(truncationMarker),
      originalLength: null,
    });
  return previews;
}

/** A stored preview, cut to the preview budget if it is somehow longer. */
function previewText(
  row: TelemetryRow,
  column: string,
): { value: string; cut: boolean } | undefined {
  const value = row[column];
  if (typeof value !== "string" || !value) return undefined;
  const budget = telemetryLimits.previewBytes;
  const cut = utf8Length(value, budget) > budget;
  return { value: cut ? utf8Head(value, budget) : value, cut };
}

/** Whether `value` is JSON, such as an arguments preview, rather than plain text. */
function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** The span's recorded events, newest last. */
function spanEvents(value: unknown): TelemetrySpanEvent[] {
  if (typeof value !== "string" || !value.startsWith("[")) return [];
  let events: unknown;
  try {
    events = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(events)) return [];
  return events
    .slice(0, spanEventLimit)
    .filter(
      (event): event is Record<string, unknown> =>
        !!event && typeof event === "object",
    )
    .map((event) => ({
      name: truncate(String(event.name ?? "event"), 80),
      time: nanosToIso(event._timestamp),
      details: Object.entries(event)
        .filter(([key]) => key !== "name" && key !== "_timestamp")
        .slice(0, 16)
        .map(([key, value]) => ({
          key,
          label: key,
          value: truncate(String(value), valueLimit),
        })),
    }));
}

// ===========================================
// Values
// ===========================================

/** The labelled facts a row has, from `specs`, each label shown once. */
function details(
  row: TelemetryRow,
  specs: readonly DetailSpec[],
): TelemetryDetail[] {
  const shown = new Set<string>();
  const result: TelemetryDetail[] = [];
  for (const [column, label] of specs) {
    const value = row[column];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      shown.has(label)
    )
      continue;
    shown.add(label);
    result.push({
      key: column,
      label,
      value: truncate(String(value), valueLimit),
    });
  }
  return result;
}

/** A bounded string column, or null when absent. */
function text(row: TelemetryRow, column: string): string | null {
  const value = row[column];
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return typeof value === "string" && value
    ? truncate(value, valueLimit)
    : null;
}

/** A boolean column, stored as a boolean or as text by some streams. */
function flag(row: TelemetryRow, column: string): boolean | null {
  const value = row[column];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** A value from a fixed set, or null. */
function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): T | null {
  return values.includes(value as T) ? (value as T) : null;
}

/** An identifier matching `pattern`, excluding the all-zero ID of records outside a trace. */
function identifier(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) && !/^0+$/.test(value)
    ? value
    : null;
}

/** OpenTelemetry severity text as one of the explorer's levels. */
function severityFromText(value: unknown): TelemetrySeverity {
  const severity = String(value ?? "").toUpperCase();
  if (severity.startsWith("ERROR") || severity.startsWith("FATAL"))
    return "error";
  if (severity.startsWith("WARN")) return "warning";
  return "info";
}

/** Microseconds since the epoch as ISO 8601. */
function microsToIso(value: unknown): string {
  const micros = Number(value);
  return new Date(
    Number.isFinite(micros) ? Math.floor(micros / 1000) : 0,
  ).toISOString();
}

/** Nanoseconds since the epoch as ISO 8601. */
function nanosToIso(value: unknown): string {
  const nanos = Number(value);
  return new Date(
    Number.isFinite(nanos) ? Math.floor(nanos / 1_000_000) : 0,
  ).toISOString();
}
