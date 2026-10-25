import { useState, type CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import type {
  TelemetryRecordSummary,
  TelemetryTrace,
} from "@everything/telemetry-contracts";
import { traceTimeline } from "../model/trace-timeline.js";
import { formatDuration, formatTime } from "../model/telemetry-presentation.js";
import { SeverityBadge } from "./severity-badge.js";
import { SpanPreviews } from "./span-previews.js";

/**
 * A trace's spans as an indented tree on one time axis, each expandable to its details, its content
 * previews, and its events, followed by the events recorded during the trace. The highlighted span starts expanded, and is
 * passed to `targetRef`; the selected event is passed to `fallbackRef`, to stand in for the span
 * until the span is in the trace.
 */
export function TraceTimeline({
  trace,
  highlightSpanId,
  selectedEventId,
  onSelectEvent,
  targetRef,
  fallbackRef,
}: {
  trace: TelemetryTrace;
  highlightSpanId: string | null;
  selectedEventId: string | null;
  onSelectEvent: (event: TelemetryRecordSummary) => void;
  targetRef?: (element: HTMLElement | null) => void;
  fallbackRef?: (element: HTMLElement | null) => void;
}) {
  const timeline = traceTimeline(trace.spans);
  const [expanded, setExpanded] = useState<string | null>(highlightSpanId);
  const [highlighted, setHighlighted] = useState(highlightSpanId);
  // A newly highlighted span opens in place of whichever was open.
  if (highlighted !== highlightSpanId) {
    setHighlighted(highlightSpanId);
    setExpanded(highlightSpanId);
  }
  return (
    <section
      className="telemetry-trace"
      aria-labelledby="telemetry-trace-heading"
    >
      <div className="telemetry-section-heading">
        <h3 id="telemetry-trace-heading">Trace</h3>
        <span>{formatDuration(timeline.durationMs)}</span>
      </div>
      {timeline.rows.length === 0 ? (
        <p className="telemetry-muted">No spans were kept for this trace.</p>
      ) : (
        <ol className="telemetry-spans" aria-label="Spans, in tree order">
          {timeline.rows.map(({ span, depth, offset, width }) => {
            const open = expanded === span.id;
            return (
              <li
                key={span.id}
                ref={span.id === highlightSpanId ? targetRef : undefined}
                className={`telemetry-span ${span.severity}${span.id === highlightSpanId ? " highlighted" : ""}`}
                style={{ "--depth": depth } as CSSProperties}
              >
                <button
                  type="button"
                  className="telemetry-span-button"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : span.id)}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="telemetry-chevron"
                  />
                  <span className="telemetry-span-name">{span.title}</span>
                  <span className="telemetry-span-duration">
                    {formatDuration(span.durationMs)}
                  </span>
                  <span
                    className="telemetry-bar"
                    aria-hidden="true"
                    style={
                      {
                        "--offset": `${(offset * 100).toFixed(2)}%`,
                        "--width": `${Math.max(width * 100, 0.6).toFixed(2)}%`,
                      } as CSSProperties
                    }
                  />
                </button>
                {open && (
                  <div className="telemetry-span-details">
                    <dl className="telemetry-facts">
                      <dt>Started</dt>
                      <dd>
                        <time dateTime={span.startTime}>
                          {formatTime(span.startTime)}
                        </time>
                      </dd>
                      <dt>Severity</dt>
                      <dd>
                        <SeverityBadge severity={span.severity} />
                      </dd>
                      {span.statusMessage && (
                        <>
                          <dt>Status</dt>
                          <dd>{span.statusMessage}</dd>
                        </>
                      )}
                      {span.textWithheld && (
                        <>
                          <dt>Error text</dt>
                          <dd>Withheld when this was recorded</dd>
                        </>
                      )}
                      {span.httpStatus !== null && (
                        <>
                          <dt>HTTP status</dt>
                          <dd>{span.httpStatus}</dd>
                        </>
                      )}
                      {span.details.map((detail) => (
                        <Fact
                          key={detail.key}
                          label={detail.label}
                          value={detail.value}
                        />
                      ))}
                    </dl>
                    <SpanPreviews
                      previews={span.previews}
                      contentWithheld={span.contentWithheld}
                    />
                    {span.events.length > 0 && (
                      <ul
                        className="telemetry-span-events"
                        aria-label="Span events"
                      >
                        {span.events.map((event, index) => (
                          <li key={`${event.name}-${index}`}>
                            <strong>{event.name}</strong>{" "}
                            <time dateTime={event.time}>
                              {formatTime(event.time)}
                            </time>
                            {event.details.length > 0 && (
                              <span>
                                {" "}
                                {event.details
                                  .map(
                                    (detail) =>
                                      `${detail.label}: ${detail.value}`,
                                  )
                                  .join(", ")}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {trace.events.length > 0 && (
        <>
          <h3 className="telemetry-subheading">Events in this trace</h3>
          <ul className="telemetry-trace-events">
            {trace.events.map((event) => (
              <li
                key={event.id}
                ref={event.id === selectedEventId ? fallbackRef : undefined}
              >
                <button
                  type="button"
                  className="telemetry-link-button"
                  aria-pressed={event.id === selectedEventId}
                  onClick={() => onSelectEvent(event)}
                >
                  <SeverityBadge severity={event.severity} />
                  <span>{event.title}</span>
                  <time dateTime={event.time}>{formatTime(event.time)}</time>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {trace.truncated && (
        <p className="telemetry-muted">
          This trace is long; only its first spans and events are shown.
        </p>
      )}
    </section>
  );
}

/** One labelled fact, shown preformatted when it spans lines. */
export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value.includes("\n") ? <pre>{value}</pre> : value}</dd>
    </>
  );
}
