/** Bounds shared by the telemetry API's validation, its queries, and the explorer's controls. */
export const telemetryLimits = {
  /** Records returned by one page unless the caller asks for fewer. */
  pageSize: 50,
  /** Most records one page may return. */
  maxPageSize: 100,
  /** Longest free-text search. */
  searchLength: 200,
  /** Longest model filter, matching provider model identifiers. */
  modelLength: 200,
  /** Longest correlation identifier: trace, span, session, run, or provider request IDs. */
  correlationLength: 128,
  /** Longest opaque pagination cursor. */
  cursorLength: 256,
  /** Most spans one trace view returns; longer traces are marked truncated. */
  traceSpanLimit: 500,
  /** Most events shown beside one trace. */
  traceEventLimit: 100,
  /**
   * Largest preview of a message, a tool call's arguments, or an SQL statement, in UTF-8 bytes.
   * Longer content is cut, and the preview says so.
   */
  previewBytes: 2_000,
  /** Most related traces listed for one trace, for each kind of relationship. */
  relatedTraceLimit: 10,
  /** Longest a span list can wait for spans to age before showing them, in seconds. */
  maxSpanDelaySeconds: 60 * 60,
  /** Shortest and longest rolling history an installation can keep, in days. */
  minRetentionDays: 3,
  maxRetentionDays: 30,
} as const;

/** Durable diagnostic records, such as model failures, or the spans that time each operation. */
export const telemetrySources = ["events", "spans"] as const;
export type TelemetrySource = (typeof telemetrySources)[number];

/**
 * What a record describes. Model covers provider requests and their failures; turn covers a
 * teammate's work on a message, its prompts, and context compaction; http covers requests to
 * Everything's API; dependency covers calls Everything makes, such as to its database; tool covers
 * a teammate's tool calls; log covers application warnings.
 */
export const telemetryTypes = [
  { id: "model", label: "Model and provider" },
  { id: "turn", label: "Teammate turns" },
  { id: "http", label: "Requests to Everything" },
  { id: "dependency", label: "Dependency calls" },
  { id: "tool", label: "Tool calls" },
  { id: "log", label: "Logs" },
] as const;
export type TelemetryType = (typeof telemetryTypes)[number]["id"];

/** How serious a record is; an error filter shows only errors, a warning filter also shows errors. */
export const telemetrySeverities = ["error", "warning", "info"] as const;
export type TelemetrySeverity = (typeof telemetrySeverities)[number];

/** How the recorded work ended: a cancellation, such as Stop, is not a failure. */
export const telemetryOutcomes = ["failure", "cancelled", "success"] as const;
export type TelemetryOutcome = (typeof telemetryOutcomes)[number];

/** Rolling time ranges the explorer offers, in minutes. */
export const telemetryTimeRanges = [
  { id: "15m", label: "Last 15 minutes", minutes: 15 },
  { id: "1h", label: "Last hour", minutes: 60 },
  { id: "24h", label: "Last day", minutes: 24 * 60 },
  { id: "7d", label: "Last week", minutes: 7 * 24 * 60 },
] as const;
export type TelemetryTimeRange = (typeof telemetryTimeRanges)[number]["id"];

/**
 * Whether the text of provider, SDK, and library error messages is recorded. Recorded by default,
 * redacted and bounded, to explain failures; an installation can withhold it, since such text can
 * quote what was sent. Categories, codes, statuses, and request IDs are recorded either way.
 */
export const telemetryErrorTextPolicies = ["withheld", "included"] as const;
export type TelemetryErrorText = (typeof telemetryErrorTextPolicies)[number];

/**
 * Whether previews of content are recorded: the message a teammate turn answered, the arguments of
 * tool calls, and SQL statements without their parameter values. Recorded by default, redacted and
 * bounded; an installation can withhold them.
 */
export const telemetryContentPolicies = ["withheld", "included"] as const;
export type TelemetryContentPolicy = (typeof telemetryContentPolicies)[number];

/**
 * Whether telemetry is turned off for the installation, reachable, or turned on but not answering.
 * Export health counts what this process could not send, without exposing the backend's address.
 */
export interface TelemetryStatus {
  readonly state: "disabled" | "available" | "unavailable";
  readonly retentionDays: number;
  /** Whether error text is recorded from now on; each record says whether its own was withheld. */
  readonly errorText: TelemetryErrorText;
  /** Whether content previews are recorded from now on; each span says whether its own were withheld. */
  readonly content: TelemetryContentPolicy;
  readonly export: TelemetryExportHealth | null;
}

/** What this process has sent to telemetry storage since it started. */
export interface TelemetryExportHealth {
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  /** Batches of records the backend refused or could not be reached for. */
  readonly failedBatches: number;
  /** Records discarded because the backend was slower than the bounded export queue. */
  readonly droppedRecords: number;
}

/**
 * Filters for one page of records. Ownership is never a filter: the API always limits results to
 * the signed-in owner. Times are ISO 8601; the range defaults to the last day.
 */
export interface TelemetryQuery {
  readonly from?: string;
  readonly to?: string;
  readonly type?: TelemetryType;
  /** Minimum severity: error, warning and above, or info and above. */
  readonly severity?: TelemetrySeverity;
  readonly outcome?: TelemetryOutcome;
  readonly agentId?: string;
  readonly provider?: string;
  /** Case-insensitive part of a model identifier. */
  readonly model?: string;
  /** A trace, span, session, run, or provider request ID. */
  readonly correlationId?: string;
  /** Case-insensitive text within a record's summary, code, category, or message. */
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
  /**
   * Spans only: leave out spans that started less than this many seconds ago, up to
   * `telemetryLimits.maxSpanDelaySeconds`, so a list shows work that has had time to finish. The
   * server applies it to its own clock. It never delays recording, and an older span's trace can
   * still be filling in.
   */
  readonly minAge?: number;
}

/** One record in a list: enough to scan and filter, with its correlation identifiers. */
export interface TelemetryRecordSummary {
  /** Event ID for events; span ID for spans. */
  readonly id: string;
  readonly source: TelemetrySource;
  readonly time: string;
  readonly type: TelemetryType;
  readonly severity: TelemetrySeverity;
  readonly outcome: TelemetryOutcome | null;
  /** Stable record name, such as `model.request.failed` or `POST /v1/agents/:agentId/messages`. */
  readonly name: string;
  /** Short summary written by Everything, never raw provider or user text. */
  readonly title: string;
  readonly category: string | null;
  readonly code: string | null;
  readonly httpStatus: number | null;
  readonly durationMs: number | null;
  readonly agentId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly traceId: string | null;
  readonly spanId: string | null;
}

/** Newest records first; the opaque cursor loads older ones. */
export interface TelemetryPage {
  readonly records: TelemetryRecordSummary[];
  readonly nextCursor: string | null;
  /** The time range searched, after defaults and retention limits. */
  readonly from: string;
  readonly to: string;
}

/** A labelled fact about a record, already redacted and bounded by the server. */
export interface TelemetryDetail {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** One event with its diagnosis: cause, codes, provider and request context, and correlation. */
export interface TelemetryEvent extends TelemetryRecordSummary {
  /**
   * A redacted, truncated excerpt of the underlying error's message, when the installation records
   * error text. It can quote what was sent.
   */
  readonly message: string | null;
  /** The error's text was left out because the installation does not record error text. */
  readonly textWithheld: boolean;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly retryable: boolean | null;
  readonly details: TelemetryDetail[];
}

/** A point in time during a span, such as a retry or a compaction. */
export interface TelemetrySpanEvent {
  readonly name: string;
  readonly time: string;
  readonly details: TelemetryDetail[];
}

/** What a span's content preview shows. */
export const telemetryPreviewKinds = [
  /** The message a teammate turn answered, as it was sent to the teammate. */
  "message",
  /** The arguments a model gave a tool call, as structured JSON. */
  "tool_arguments",
  /** An SQL statement with placeholders, without its parameter values. */
  "sql",
] as const;
export type TelemetryPreviewKind = (typeof telemetryPreviewKinds)[number];

/**
 * A bounded preview of what a span worked on, redacted for credentials before it was stored. A
 * preview is never the whole payload once it is marked truncated.
 */
export interface TelemetryPreview {
  readonly kind: TelemetryPreviewKind;
  /** How the value reads: plain text, JSON, or SQL. */
  readonly format: "text" | "json" | "sql";
  readonly value: string;
  /** Part of the content was cut or summarized to fit `telemetryLimits.previewBytes`. */
  readonly truncated: boolean;
  /** Characters in the original, when known, such as a message's length. */
  readonly originalLength: number | null;
}

/** One timed operation within a trace. */
export interface TelemetrySpan extends TelemetryRecordSummary {
  readonly parentSpanId: string | null;
  readonly kind: "server" | "client" | "internal" | "producer" | "consumer";
  readonly startTime: string;
  /** Everything's own status text, or the error's when the installation records error text. */
  readonly statusMessage: string | null;
  /** The span's error text was left out because the installation does not record error text. */
  readonly textWithheld: boolean;
  /** Previews of the content the span worked on, when the installation records content. */
  readonly previews: TelemetryPreview[];
  /** The span's content previews were left out because the installation does not record them. */
  readonly contentWithheld: boolean;
  readonly details: TelemetryDetail[];
  readonly events: TelemetrySpanEvent[];
}

/** How another trace relates to the one shown. */
export const telemetryRelations = [
  /** A span in another trace started this trace's work, as the link recorded when it started says. */
  "started_by",
  /** This trace's work started another trace, which links back to it. */
  "started",
  /** Another trace recorded the same run, such as a request and the teammate turn it started. */
  "same_run",
] as const;
export type TelemetryRelation = (typeof telemetryRelations)[number];

/** A span in another of the owner's traces, and how it relates to this one. */
export interface TelemetryRelatedSpan {
  readonly relation: TelemetryRelation;
  /** The span to open: the one that started this work, or the earliest recorded span of the other trace. */
  readonly span: TelemetrySpan;
  /** The span in this trace the relationship belongs to, when it is known. */
  readonly localSpanId: string | null;
}

/**
 * Other traces related to one trace, from links recorded when work started and from run IDs, never
 * from timing. Each trace stays separate; only the owner's own traces are listed. A trace whose
 * work is still running may not be listed yet, since a span is stored when it ends.
 */
export interface TelemetryTraceRelations {
  readonly related: TelemetryRelatedSpan[];
  /**
   * A link recorded in this trace names work that isn't available: it may not have been stored
   * yet, or it has expired.
   */
  readonly unresolved: boolean;
  /** More related traces exist than are listed. */
  readonly truncated: boolean;
}

/**
 * The owner's spans and events of one trace, in start order. Spans the owner cannot see are
 * omitted, so a trace that belongs to someone else looks the same as one that does not exist.
 */
export interface TelemetryTrace {
  readonly traceId: string;
  readonly spans: TelemetrySpan[];
  readonly events: TelemetryRecordSummary[];
  /** More spans or events exist than one trace view returns. */
  readonly truncated: boolean;
  /** Related traces, or null when they couldn't be looked up this time. */
  readonly relations: TelemetryTraceRelations | null;
}
