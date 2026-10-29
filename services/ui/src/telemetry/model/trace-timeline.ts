import type { TelemetrySpan } from "@everything/telemetry-contracts";

/** One span's row in a trace's timeline. */
export interface TimelineRow {
  readonly span: TelemetrySpan;
  /** Nesting below the trace's top-level spans. */
  readonly depth: number;
  /** Where the span starts, as a share of the trace's duration. */
  readonly offset: number;
  /** How long the span lasts, as a share of the trace's duration. */
  readonly width: number;
}

/** A trace's spans in tree order, positioned on one time axis. */
export interface TraceTimeline {
  readonly rows: TimelineRow[];
  readonly durationMs: number;
}

/**
 * Order spans as a tree, each followed by its children in start order, and place them on the
 * trace's time axis. Spans whose parent is not visible start trees of their own.
 */
export function traceTimeline(spans: readonly TelemetrySpan[]): TraceTimeline {
  const starts = new Map(
    spans.map((span) => [span.id, Date.parse(span.startTime)]),
  );
  const begin = Math.min(...starts.values());
  const end = Math.max(
    ...spans.map(
      (span) => (starts.get(span.id) ?? begin) + (span.durationMs ?? 0),
    ),
  );
  const durationMs =
    Number.isFinite(begin) && Number.isFinite(end) ? end - begin : 0;
  const ids = new Set(spans.map((span) => span.id));
  const children = new Map<string, TelemetrySpan[]>();
  const roots: TelemetrySpan[] = [];
  for (const span of spans) {
    if (
      span.parentSpanId &&
      ids.has(span.parentSpanId) &&
      span.parentSpanId !== span.id
    )
      children.set(span.parentSpanId, [
        ...(children.get(span.parentSpanId) ?? []),
        span,
      ]);
    else roots.push(span);
  }
  const byStart = (a: TelemetrySpan, b: TelemetrySpan) =>
    (starts.get(a.id) ?? 0) - (starts.get(b.id) ?? 0);
  const rows: TimelineRow[] = [];
  const visited = new Set<string>();
  const visit = (span: TelemetrySpan, depth: number) => {
    if (visited.has(span.id)) return;
    visited.add(span.id);
    const start = (starts.get(span.id) ?? begin) - begin;
    rows.push({
      span,
      depth,
      offset: durationMs > 0 ? start / durationMs : 0,
      width:
        durationMs > 0 ? Math.max(0, (span.durationMs ?? 0) / durationMs) : 1,
    });
    for (const child of (children.get(span.id) ?? []).sort(byStart))
      visit(child, depth + 1);
  };
  for (const root of roots.sort(byStart)) visit(root, 0);
  // Spans in a parent cycle were never reached from a root; show them at the top level.
  for (const span of spans) visit(span, 0);
  return { rows, durationMs };
}
