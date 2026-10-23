import type {
  TelemetryOutcome,
  TelemetrySeverity,
  TelemetryType,
} from "@everything/telemetry-contracts";
import {
  telemetryAttributes as attribute,
  telemetryColumn,
} from "../model/telemetry-attributes.js";
import type { TelemetryStreamType } from "../interface/telemetry-search.js";

/** A page's position: the time and key of the last record already shown. */
export interface TelemetryCursor {
  /** Microseconds since the epoch, the backend's time column. */
  readonly time: number;
  readonly key: string;
}

/** Validated filters for one page; the owner always comes from the verified caller. */
export interface TelemetryFilter {
  readonly ownerId: string;
  readonly type?: TelemetryType;
  readonly severity?: TelemetrySeverity;
  readonly outcome?: TelemetryOutcome;
  readonly agentId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly correlationId?: string;
  readonly search?: string;
  readonly cursor?: TelemetryCursor;
}

/**
 * A query to run, or `null` when a filter names a column the stream has never received, so no
 * record can match and the backend need not be asked.
 */
export type TelemetrySql = string | null;

/** Columns used by every query. */
const column = {
  time: "_timestamp",
  owner: telemetryColumn(attribute.ownerId),
  type: telemetryColumn(attribute.type),
  severity: telemetryColumn(attribute.severity),
  outcome: telemetryColumn(attribute.outcome),
  agent: telemetryColumn(attribute.agentId),
  provider: telemetryColumn(attribute.provider),
  model: telemetryColumn(attribute.model),
  eventId: telemetryColumn(attribute.eventId),
  traceId: "trace_id",
  spanId: "span_id",
  startTime: "start_time",
} as const;

/** The column that orders records with the same time, per stream. */
const keyColumns: Readonly<Record<TelemetryStreamType, string>> = {
  logs: column.eventId,
  traces: column.spanId,
};

/** Columns a correlation ID may match, per stream. */
const correlationColumns: Readonly<
  Record<TelemetryStreamType, readonly string[]>
> = {
  logs: [
    column.traceId,
    column.spanId,
    telemetryColumn(attribute.sessionId),
    telemetryColumn(attribute.runId),
    telemetryColumn(attribute.requestId),
    column.eventId,
  ],
  traces: [
    column.traceId,
    column.spanId,
    telemetryColumn(attribute.sessionId),
    telemetryColumn(attribute.runId),
    telemetryColumn(attribute.requestId),
  ],
};

/** Columns free-text search reads, per stream. */
const searchColumns: Readonly<Record<TelemetryStreamType, readonly string[]>> =
  {
    logs: [
      "body",
      telemetryColumn(attribute.event),
      telemetryColumn(attribute.message),
      telemetryColumn(attribute.code),
      telemetryColumn(attribute.category),
      telemetryColumn(attribute.errorType),
    ],
    traces: [
      "operation_name",
      "status_message",
      telemetryColumn(attribute.code),
      telemetryColumn(attribute.tool),
      telemetryColumn(attribute.httpRoute),
      telemetryColumn(attribute.serverAddress),
    ],
  };

/** Severity filters as the severities each includes. */
const severityLevels: Readonly<
  Record<TelemetrySeverity, readonly TelemetrySeverity[]>
> = {
  error: ["error"],
  warning: ["error", "warning"],
  info: ["error", "warning", "info"],
};

/** Stream names OpenObserve accepts, which are quoted as identifiers. */
const streamPattern = /^[a-z0-9_]{1,64}$/;

/**
 * Text that cannot be written into a SQL string literal safely. OpenObserve's SQL dialect treats a
 * backslash as an escape character, so doubling quotes alone would let `\'` end a literal.
 */
const unsafeLiteral = /[\\\u0000-\u001F\u007F]/;

/** Write `value` as a single-quoted SQL string, refusing anything that could end the literal. */
export function sqlLiteral(value: string): string {
  if (unsafeLiteral.test(value))
    throw new Error(
      "Telemetry filters cannot contain backslashes or control characters",
    );
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Build OpenObserve SQL from validated filters only: the stream, columns, operators, and ordering
 * are fixed here, and every caller-supplied value becomes an escaped literal. Every query is limited
 * to the caller's own records, so no filter, cursor, or identifier can reach another owner's data.
 */
export class TelemetryQueryBuilder {
  // ===========================================
  // Construction
  // ===========================================

  /** Query the configured stream. */
  constructor(private readonly stream: string) {
    if (!streamPattern.test(stream))
      throw new Error("Invalid telemetry stream name");
  }

  // ===========================================
  // Queries
  // ===========================================

  /** One page of the owner's records, newest first, with one extra row to detect a next page. */
  page(
    type: TelemetryStreamType,
    filter: TelemetryFilter,
    fields: ReadonlySet<string>,
    limit: number,
  ): TelemetrySql {
    const conditions = [this.owner(filter.ownerId, fields)];
    const key = keyColumns[type];
    if (filter.type !== undefined)
      conditions.push(equal(column.type, filter.type, fields));
    if (filter.severity !== undefined && filter.severity !== "info")
      conditions.push(
        oneOf(column.severity, severityLevels[filter.severity], fields),
      );
    if (filter.outcome !== undefined)
      conditions.push(equal(column.outcome, filter.outcome, fields));
    if (filter.agentId !== undefined)
      conditions.push(equal(column.agent, filter.agentId, fields));
    if (filter.provider !== undefined)
      conditions.push(equal(column.provider, filter.provider, fields));
    if (filter.model !== undefined)
      conditions.push(contains([column.model], filter.model, fields));
    if (filter.correlationId !== undefined)
      conditions.push(
        anyEqual(correlationColumns[type], filter.correlationId, fields),
      );
    if (filter.search !== undefined)
      conditions.push(contains(searchColumns[type], filter.search, fields));
    if (filter.cursor) {
      if (!fields.has(key)) return null;
      const time = Math.trunc(filter.cursor.time);
      conditions.push(
        `(${column.time} < ${time} OR (${column.time} = ${time} AND ${key} < ${sqlLiteral(filter.cursor.key)}))`,
      );
    }
    if (conditions.includes(null) || !fields.has(key)) return null;
    return `${this.select(conditions as string[])} ORDER BY ${column.time} DESC, ${key} DESC LIMIT ${bound(limit) + 1}`;
  }

  /** One of the owner's events by its ID. */
  event(
    ownerId: string,
    eventId: string,
    fields: ReadonlySet<string>,
  ): TelemetrySql {
    const conditions = [
      this.owner(ownerId, fields),
      equal(column.eventId, eventId, fields),
    ];
    if (conditions.includes(null)) return null;
    return `${this.select(conditions as string[])} LIMIT 1`;
  }

  /** The owner's records in one trace, oldest first; another owner's trace matches nothing. */
  trace(
    type: TelemetryStreamType,
    ownerId: string,
    traceId: string,
    fields: ReadonlySet<string>,
    limit: number,
  ): TelemetrySql {
    const conditions = [
      this.owner(ownerId, fields),
      equal(column.traceId, traceId, fields),
    ];
    if (conditions.includes(null)) return null;
    const order = type === "traces" ? column.startTime : column.time;
    return `${this.select(conditions as string[])} ORDER BY ${order} ASC LIMIT ${bound(limit) + 1}`;
  }

  // ===========================================
  // Clauses
  // ===========================================

  /** The owner condition every query starts with. */
  private owner(ownerId: string, fields: ReadonlySet<string>): string | null {
    if (!ownerId) throw new Error("Telemetry queries require an owner");
    return equal(column.owner, ownerId, fields);
  }

  /** Every column of the stream's records matching all conditions. */
  private select(conditions: readonly string[]): string {
    return `SELECT * FROM "${this.stream}" WHERE ${conditions.join(" AND ")}`;
  }
}

/** A row count from 1 to 500. */
function bound(limit: number): number {
  return Math.min(500, Math.max(1, Math.trunc(limit)));
}

/** `column = value`, or nothing can match when the column is absent. */
function equal(
  name: string,
  value: string,
  fields: ReadonlySet<string>,
): string | null {
  return fields.has(name) ? `${name} = ${sqlLiteral(value)}` : null;
}

/** `column IN (values)`, or nothing can match when the column is absent. */
function oneOf(
  name: string,
  values: readonly string[],
  fields: ReadonlySet<string>,
): string | null {
  return fields.has(name)
    ? `${name} IN (${values.map(sqlLiteral).join(", ")})`
    : null;
}

/** Any present column equal to `value`, or nothing can match when none is present. */
function anyEqual(
  names: readonly string[],
  value: string,
  fields: ReadonlySet<string>,
): string | null {
  const present = names.filter((name) => fields.has(name));
  return present.length
    ? `(${present.map((name) => `${name} = ${sqlLiteral(value)}`).join(" OR ")})`
    : null;
}

/** Any present column containing `value`, ignoring case. */
function contains(
  names: readonly string[],
  value: string,
  fields: ReadonlySet<string>,
): string | null {
  const present = names.filter((name) => fields.has(name));
  return present.length
    ? `(${present.map((name) => `str_match_ignore_case(${name}, ${sqlLiteral(value)})`).join(" OR ")})`
    : null;
}
