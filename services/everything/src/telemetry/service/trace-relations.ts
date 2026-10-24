import {
  telemetryLimits,
  type TelemetryRelatedSpan,
  type TelemetryTraceRelations,
} from "@everything/telemetry-contracts";
import type {
  TelemetryRow,
  TelemetryStreamType,
} from "../interface/telemetry-search.js";
import {
  telemetryAttributes as attribute,
  telemetryColumn,
} from "../model/telemetry-attributes.js";
import {
  spanLinks,
  spanRecord,
  type SpanLink,
} from "../presenter/telemetry-records.js";
import type {
  TelemetryQueryBuilder,
  TelemetrySql,
} from "./telemetry-query-builder.js";

/** Run one built query over the retention period, returning at most `size` rows. */
export type RelationQuery = (
  type: TelemetryStreamType,
  build: (fields: ReadonlySet<string>) => TelemetrySql,
  size: number,
) => Promise<TelemetryRow[]>;

/** Most links of a trace's spans looked up at once. */
const linkLookupLimit = 16;

/** Most run IDs of one trace looked up, since a trace normally records one. */
const runLookupLimit = 4;

/** Run IDs Everything writes, which become SQL literals. */
const runIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A W3C trace ID, lowercase hexadecimal. */
const traceIdPattern = /^[0-9a-f]{32}$/;

/** The owner and run columns, read back from every row. */
const ownerColumn = telemetryColumn(attribute.ownerId);
const runColumn = telemetryColumn(attribute.runId);

/**
 * Find the owner's other traces related to one trace, from what was recorded rather than from
 * timing: the spans its links name, which started its work; the traces whose links name it, whose
 * work it started; and the traces that recorded the same run, such as a request and the teammate
 * turn it started, which turns up a turn while it is still running. Each lookup is bounded, every
 * row is checked against the owner again, and a link whose other end isn't the owner's is reported
 * only as unresolved, without its IDs.
 */
export class TraceRelations {
  // ===========================================
  // Construction
  // ===========================================

  /** Build queries with `builder` and run them with `query`, listing up to `limit` of each kind. */
  constructor(
    private readonly builder: TelemetryQueryBuilder,
    private readonly query: RelationQuery,
    private readonly limit: number = telemetryLimits.relatedTraceLimit,
  ) {}

  // ===========================================
  // Operations
  // ===========================================

  /** The relations of trace `traceId`, whose owned span rows are `spans`. */
  async find(
    ownerId: string,
    traceId: string,
    spans: readonly TelemetryRow[],
  ): Promise<TelemetryTraceRelations> {
    const [startedBy, started, sameRun] = await Promise.all([
      this.startedBy(ownerId, traceId, spans),
      this.started(ownerId, traceId, spans),
      this.sameRun(ownerId, traceId, spans),
    ]);
    // A trace related by a link is listed once, by the link, even when it shares the run too.
    const linked = new Set(
      [...startedBy.related, ...started.related].map(
        (related) => related.span.traceId,
      ),
    );
    return {
      related: [
        ...startedBy.related,
        ...started.related,
        ...sameRun.related.filter(
          (related) => !linked.has(related.span.traceId),
        ),
      ],
      unresolved: startedBy.unresolved,
      truncated: startedBy.truncated || started.truncated || sameRun.truncated,
    };
  }

  // ===========================================
  // Relations
  // ===========================================

  /** The spans in other traces that this trace's links name. */
  private async startedBy(
    ownerId: string,
    traceId: string,
    spans: readonly TelemetryRow[],
  ): Promise<Found> {
    const links = new Map<string, SpanLink & { localSpanId: string }>();
    for (const row of spans)
      for (const link of spanLinks(row))
        if (link.traceId !== traceId && typeof row.span_id === "string")
          links.set(`${link.traceId}:${link.spanId}`, {
            ...link,
            localSpanId: row.span_id,
          });
    if (!links.size) return none;
    const wanted = [...links.values()].slice(0, linkLookupLimit);
    const rows = owned(
      await this.query(
        "traces",
        (fields) =>
          this.builder.spansById(ownerId, wanted, fields, wanted.length),
        wanted.length + 1,
      ),
      ownerId,
    );
    const found = new Map(
      rows.map((row) => [
        `${String(row.trace_id)}:${String(row.span_id)}`,
        row,
      ]),
    );
    const related: TelemetryRelatedSpan[] = [];
    for (const link of wanted) {
      const row = found.get(`${link.traceId}:${link.spanId}`);
      if (row)
        related.push({
          relation: "started_by",
          span: spanRecord(row),
          localSpanId: link.localSpanId,
        });
    }
    return {
      related: related.slice(0, this.limit),
      unresolved: related.length < wanted.length,
      truncated: links.size > wanted.length || related.length > this.limit,
    };
  }

  /** The first spans of other traces whose links name this one, one per trace. */
  private async started(
    ownerId: string,
    traceId: string,
    spans: readonly TelemetryRow[],
  ): Promise<Found> {
    const local = new Set(spans.map((row) => row.span_id));
    const rows = owned(
      await this.query(
        "traces",
        (fields) => this.builder.linkedTo(ownerId, traceId, fields, this.limit),
        this.limit + 1,
      ),
      ownerId,
    );
    const related: TelemetryRelatedSpan[] = [];
    const traces = new Set<string>();
    for (const row of rows) {
      // The query matches stored text; only a link that names this trace counts.
      const link = spanLinks(row).find((link) => link.traceId === traceId);
      const span = spanRecord(row);
      if (!link || !span.traceId || traces.has(span.traceId)) continue;
      traces.add(span.traceId);
      related.push({
        relation: "started",
        span,
        localSpanId: local.has(link.spanId) ? link.spanId : null,
      });
    }
    return {
      related: related.slice(0, this.limit),
      unresolved: false,
      truncated: rows.length > this.limit,
    };
  }

  /** The earliest span of each other trace that recorded one of this trace's runs. */
  private async sameRun(
    ownerId: string,
    traceId: string,
    spans: readonly TelemetryRow[],
  ): Promise<Found> {
    const runIds = [
      ...new Set(
        spans
          .map((row) => row[runColumn])
          .filter(
            (value): value is string =>
              typeof value === "string" && runIdPattern.test(value),
          ),
      ),
    ].slice(0, runLookupLimit);
    if (!runIds.length) return none;
    const groups = await this.query(
      "traces",
      (fields) =>
        this.builder.runTraces(ownerId, runIds, traceId, fields, this.limit),
      (this.limit + 1) * runIds.length,
    );
    // Only groups proven to be this owner's, for one of these runs, are counted or looked up, so
    // nothing another owner recorded, even from a backend that ignores the owner condition, can
    // change what this trace reports.
    const earliest = new Map<string, number>();
    for (const group of groups) {
      const candidate = group.trace_id;
      const time = Number(group.first_time);
      if (
        group[ownerColumn] !== ownerId ||
        !runIds.includes(group[runColumn] as string) ||
        typeof candidate !== "string" ||
        !traceIdPattern.test(candidate) ||
        candidate === traceId ||
        !Number.isSafeInteger(time) ||
        time <= 0
      )
        continue;
      earliest.set(candidate, Math.min(earliest.get(candidate) ?? time, time));
    }
    const verified = [...earliest]
      .map(([candidate, time]) => ({ traceId: candidate, time }))
      .sort((a, b) => a.time - b.time);
    const starts = verified.slice(0, this.limit);
    if (!starts.length) return none;
    const rows = owned(
      await this.query(
        "traces",
        (fields) =>
          this.builder.firstSpans(ownerId, starts, fields, starts.length * 4),
        starts.length * 4 + 1,
      ),
      ownerId,
    ).filter((row) => runIds.includes(row[runColumn] as string));
    const related: TelemetryRelatedSpan[] = [];
    for (const start of starts) {
      const first = rows.filter(
        (row) =>
          row.trace_id === start.traceId &&
          Number(row._timestamp) === start.time,
      );
      // A trace's root span, if it has arrived, explains it best.
      const row =
        first.find((candidate) => !candidate.reference_parent_span_id) ??
        first[0];
      if (row)
        related.push({
          relation: "same_run",
          span: spanRecord(row),
          localSpanId: null,
        });
    }
    return {
      related,
      unresolved: false,
      truncated: verified.length > this.limit,
    };
  }
}

/** Related spans of one kind, with whether any were unresolved or left out. */
interface Found {
  readonly related: TelemetryRelatedSpan[];
  readonly unresolved: boolean;
  readonly truncated: boolean;
}

/** Nothing found, and nothing to find. */
const none: Found = { related: [], unresolved: false, truncated: false };

/** Rows that belong to the owner; anything else the backend returns is discarded. */
function owned(rows: readonly TelemetryRow[], ownerId: string): TelemetryRow[] {
  return rows.filter((row) => row[ownerColumn] === ownerId);
}
