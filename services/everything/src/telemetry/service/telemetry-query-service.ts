import {
  telemetryLimits,
  type TelemetryEvent,
  type TelemetryExportHealth,
  type TelemetryPage,
  type TelemetryQuery,
  type TelemetryRecordSummary,
  type TelemetryStatus,
  type TelemetryTrace,
} from "@everything/telemetry-contracts";
import {
  InvalidTelemetryCursorError,
  InvalidTelemetryRangeError,
  TelemetryDisabledError,
  TelemetryRecordNotFoundError,
  TelemetrySearchError,
  TelemetryUnavailableError,
  unknownTelemetryField,
} from "../error/telemetry-errors.js";
import type { TelemetryReader } from "../interface/telemetry-reader.js";
import type {
  TelemetryRow,
  TelemetrySearch,
  TelemetryStreamType,
  TelemetryWindow,
} from "../interface/telemetry-search.js";
import {
  telemetryAttributes as attribute,
  telemetryColumn,
} from "../model/telemetry-attributes.js";
import {
  eventDetail,
  eventSummary,
  spanRecord,
} from "../presenter/telemetry-records.js";
import {
  TelemetryQueryBuilder,
  type TelemetryCursor,
  type TelemetrySql,
} from "./telemetry-query-builder.js";

/** The configured backend, when telemetry is on and its credentials could be read. */
export interface TelemetryBackend {
  readonly search: TelemetrySearch;
  readonly stream: string;
}

/** How long a stream's columns and the backend's availability are reused. */
const cacheMs = 10_000;

/** The default range when the caller names none. */
const defaultRangeMs = 24 * 60 * 60_000;

/** How far in the future an end time may be, for clocks slightly ahead of the server's. */
const clockSkewMs = 5 * 60_000;

/** The owner column, read back to check every row the backend returns. */
const ownerColumn = telemetryColumn(attribute.ownerId);

/** Each stream's page key column, which a cursor records. */
const keyColumns: Readonly<Record<TelemetryStreamType, string>> = {
  logs: telemetryColumn(attribute.eventId),
  traces: "span_id",
};

/**
 * Read the owner's telemetry through validated queries. Ranges are bounded by retention, pages by
 * opaque cursors, and every row the backend returns is checked against the owner again before it
 * is presented, so a backend or query defect cannot show another owner's records.
 */
export class TelemetryQueryService implements TelemetryReader {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly builder: TelemetryQueryBuilder | undefined;
  private readonly schemas = new Map<
    TelemetryStreamType,
    { fields: ReadonlySet<string>; expiresAt: number }
  >();
  private availability: { value: boolean; expiresAt: number } | undefined;

  /**
   * Read from `backend`, or report telemetry as turned off or unavailable without one. Export
   * health comes from this process's telemetry runtime, if it started.
   */
  constructor(
    private readonly settings: {
      readonly enabled: boolean;
      readonly retentionDays: number;
      /** Whether error text is recorded; withheld unless set. */
      readonly includeErrorText?: boolean;
    },
    private readonly backend: TelemetryBackend | null,
    private readonly exportHealth: () => TelemetryExportHealth | null = () =>
      null,
    private readonly now: () => number = Date.now,
  ) {
    this.builder = backend
      ? new TelemetryQueryBuilder(backend.stream)
      : undefined;
  }

  // ===========================================
  // Operations
  // ===========================================

  /** Turned off, answering, or not answering, with the error-text setting and this process's export health. */
  async status(): Promise<TelemetryStatus> {
    const retentionDays = this.settings.retentionDays;
    const errorText = this.settings.includeErrorText ? "included" : "withheld";
    if (!this.settings.enabled)
      return { state: "disabled", retentionDays, errorText, export: null };
    const available = this.backend
      ? await this.available(this.backend.search)
      : false;
    return {
      state: available ? "available" : "unavailable",
      retentionDays,
      errorText,
      export: this.exportHealth(),
    };
  }

  /** A page of the owner's events. */
  events(ownerId: string, query: TelemetryQuery): Promise<TelemetryPage> {
    return this.page("logs", ownerId, query);
  }

  /** A page of the owner's spans. */
  spans(ownerId: string, query: TelemetryQuery): Promise<TelemetryPage> {
    return this.page("traces", ownerId, query);
  }

  /** One of the owner's events, searched across the retention period. */
  async event(ownerId: string, eventId: string): Promise<TelemetryEvent> {
    const { builder } = this.requireBackend();
    const rows = await this.run(
      "logs",
      (fields) => builder.event(ownerId, eventId, fields),
      this.retentionWindow(),
      1,
    );
    const row = owned(rows, ownerId)[0];
    if (!row) throw new TelemetryRecordNotFoundError();
    return eventDetail(row);
  }

  /** The owner's spans and events of one trace; a trace with neither does not exist for them. */
  async trace(ownerId: string, traceId: string): Promise<TelemetryTrace> {
    const { builder } = this.requireBackend();
    const window = this.retentionWindow();
    const [spanRows, eventRows] = await Promise.all([
      this.run(
        "traces",
        (fields) =>
          builder.trace(
            "traces",
            ownerId,
            traceId,
            fields,
            telemetryLimits.traceSpanLimit,
          ),
        window,
        telemetryLimits.traceSpanLimit + 1,
      ),
      this.run(
        "logs",
        (fields) =>
          builder.trace(
            "logs",
            ownerId,
            traceId,
            fields,
            telemetryLimits.traceEventLimit,
          ),
        window,
        telemetryLimits.traceEventLimit + 1,
      ),
    ]);
    const spans = owned(spanRows, ownerId);
    const events = owned(eventRows, ownerId);
    if (!spans.length && !events.length)
      throw new TelemetryRecordNotFoundError();
    return {
      traceId,
      spans: spans.slice(0, telemetryLimits.traceSpanLimit).map(spanRecord),
      events: events
        .slice(0, telemetryLimits.traceEventLimit)
        .map(eventSummary),
      truncated:
        spans.length > telemetryLimits.traceSpanLimit ||
        events.length > telemetryLimits.traceEventLimit,
    };
  }

  // ===========================================
  // Pages
  // ===========================================

  /** A page of one stream, newest first, with a cursor when older records remain. */
  private async page(
    type: TelemetryStreamType,
    ownerId: string,
    query: TelemetryQuery,
  ): Promise<TelemetryPage> {
    const { builder } = this.requireBackend();
    const window = this.window(query.from, query.to);
    const cursor =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const limit = Math.min(
      telemetryLimits.maxPageSize,
      Math.max(1, query.limit ?? telemetryLimits.pageSize),
    );
    const rows = owned(
      await this.run(
        type,
        (fields) =>
          builder.page(
            type,
            {
              ownerId,
              ...(query.type !== undefined ? { type: query.type } : {}),
              ...(query.severity !== undefined
                ? { severity: query.severity }
                : {}),
              ...(query.outcome !== undefined
                ? { outcome: query.outcome }
                : {}),
              ...(query.agentId !== undefined
                ? { agentId: query.agentId }
                : {}),
              ...(query.provider !== undefined
                ? { provider: query.provider }
                : {}),
              ...(query.model !== undefined ? { model: query.model } : {}),
              ...(query.correlationId !== undefined
                ? { correlationId: query.correlationId }
                : {}),
              ...(query.search !== undefined ? { search: query.search } : {}),
              ...(cursor ? { cursor } : {}),
            },
            fields,
            limit,
          ),
        window,
        limit + 1,
      ),
      ownerId,
    );
    const records: TelemetryRecordSummary[] = rows
      .slice(0, limit)
      .map((row) => (type === "logs" ? eventSummary(row) : spanRecord(row)));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      records,
      nextCursor: last ? encodeCursor(last, keyColumns[type]) : null,
      from: new Date(window.start / 1000).toISOString(),
      to: new Date(window.end / 1000).toISOString(),
    };
  }

  // ===========================================
  // Backend access
  // ===========================================

  /**
   * Build and run a query against the stream's current columns. A query that names a column the
   * cached schema lacks, or that the backend reports missing, is built again once with fresh
   * columns; a stream that still lacks the column matches nothing.
   */
  private async run(
    type: TelemetryStreamType,
    build: (fields: ReadonlySet<string>) => TelemetrySql,
    window: TelemetryWindow,
    size: number,
  ): Promise<TelemetryRow[]> {
    const { search } = this.requireBackend();
    for (let attempt = 0; attempt < 2; attempt++) {
      const sql = build(await this.fields(type, attempt > 0));
      // A column the cached schema lacks may have arrived since; check fresh columns once.
      if (sql === null) {
        if (attempt === 0) continue;
        return [];
      }
      try {
        return await search.search(type, sql, window, size);
      } catch (error) {
        if (
          !(error instanceof TelemetrySearchError) ||
          error.code !== unknownTelemetryField
        )
          throw new TelemetryUnavailableError();
      }
    }
    return [];
  }

  /** The stream's columns, reused briefly. */
  private async fields(
    type: TelemetryStreamType,
    refresh: boolean,
  ): Promise<ReadonlySet<string>> {
    const cached = this.schemas.get(type);
    if (!refresh && cached && cached.expiresAt > this.now())
      return cached.fields;
    try {
      const fields = await this.requireBackend().search.fields(type);
      this.schemas.set(type, { fields, expiresAt: this.now() + cacheMs });
      return fields;
    } catch {
      throw new TelemetryUnavailableError();
    }
  }

  /** Whether the backend answers, reused briefly so status polling stays cheap. */
  private async available(search: TelemetrySearch): Promise<boolean> {
    if (this.availability && this.availability.expiresAt > this.now())
      return this.availability.value;
    const value = await search.available();
    this.availability = { value, expiresAt: this.now() + cacheMs };
    return value;
  }

  /** The backend and its query builder, or the reason there are none. */
  private requireBackend(): {
    search: TelemetrySearch;
    builder: TelemetryQueryBuilder;
  } {
    if (!this.settings.enabled) throw new TelemetryDisabledError();
    if (!this.backend || !this.builder) throw new TelemetryUnavailableError();
    return { search: this.backend.search, builder: this.builder };
  }

  // ===========================================
  // Time
  // ===========================================

  /** The requested range, defaulting to the last day and cut to the retention period. */
  private window(
    from: string | undefined,
    to: string | undefined,
  ): TelemetryWindow {
    const now = this.now();
    const earliest = now - this.settings.retentionDays * 24 * 60 * 60_000;
    const end = Math.min(
      to === undefined ? now : Date.parse(to),
      now + clockSkewMs,
    );
    const start = Math.max(
      from === undefined ? end - defaultRangeMs : Date.parse(from),
      earliest,
    );
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      throw new InvalidTelemetryRangeError(this.settings.retentionDays);
    return { start: start * 1000, end: end * 1000 };
  }

  /** The whole retention period, for lookups by identifier. */
  private retentionWindow(): TelemetryWindow {
    const now = this.now();
    return {
      start: (now - this.settings.retentionDays * 24 * 60 * 60_000) * 1000,
      end: (now + clockSkewMs) * 1000,
    };
  }
}

/** Rows that belong to the owner; anything else the backend returns is discarded. */
function owned(rows: readonly TelemetryRow[], ownerId: string): TelemetryRow[] {
  return rows.filter((row) => row[ownerColumn] === ownerId);
}

/** A cursor after `row`: its time and page key, encoded so callers treat it as opaque. */
function encodeCursor(row: TelemetryRow, keyColumn: string): string | null {
  const time = Number(row._timestamp);
  const key = row[keyColumn];
  if (!Number.isSafeInteger(time) || typeof key !== "string") return null;
  return Buffer.from(JSON.stringify([time, key])).toString("base64url");
}

/** The time and key a cursor encodes, refusing anything this API did not issue. */
function decodeCursor(value: string): TelemetryCursor {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      Number.isSafeInteger(decoded[0]) &&
      decoded[0] > 0 &&
      typeof decoded[1] === "string" &&
      /^[A-Za-z0-9-]{1,64}$/.test(decoded[1])
    )
      return { time: decoded[0], key: decoded[1] };
  } catch {
    // Fall through to the uniform refusal.
  }
  throw new InvalidTelemetryCursorError();
}
