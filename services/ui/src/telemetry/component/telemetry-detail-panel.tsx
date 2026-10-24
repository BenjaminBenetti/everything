import { useEffect, useRef } from "react";
import { ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";
import type {
  TelemetryEvent,
  TelemetryRecordSummary,
} from "@everything/telemetry-contracts";
import { Button, IconButton } from "@everything/ui/button";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import {
  useTelemetryEvent,
  useTelemetryTrace,
} from "./telemetry-client-provider.js";
import {
  describeCause,
  formatDuration,
  formatTime,
  outcomeLabels,
  teammateName,
  typeLabel,
} from "../model/telemetry-presentation.js";
import { providerOptions } from "../../provider/model/provider-options.js";
import { useScrollReveal } from "../hook/use-scroll-reveal.js";
import { useVisibleHeight } from "../hook/use-visible-height.js";
import { SeverityBadge } from "./severity-badge.js";
import { Fact, TraceTimeline } from "./trace-timeline.js";

/** Provider IDs as their names. */
function providerName(provider: string | null): string | null {
  if (!provider) return null;
  return provider in providerOptions
    ? providerOptions[provider as keyof typeof providerOptions].title
    : provider;
}

/**
 * The selected record's diagnosis: what happened in plain words with the next step, the codes,
 * status, and IDs that identify it, the teammate it concerns, and the trace it belongs to. It is
 * fetched by ID, so it stays open while the list refreshes or loads more records. While
 * `watching`, a trace whose work may still be finishing is checked again for records that arrive.
 *
 * The panel fits the visible part of the page and scrolls its own contents below a header that
 * stays in view. Once the trace is shown, it scrolls itself, never the page, to the selected
 * record's span.
 */
export function TelemetryDetailPanel({
  record,
  teammates,
  watching,
  onSelect,
  onClose,
}: {
  record: TelemetryRecordSummary;
  teammates:
    readonly { readonly id: string; readonly name: string }[] | undefined;
  watching: boolean;
  onSelect: (record: TelemetryRecordSummary) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const event = useTelemetryEvent(
    record.source === "events" ? record.id : undefined,
  );
  const trace = useTelemetryTrace(record.traceId, record.time, watching);
  const traceMissing =
    trace.error instanceof HttpRequestError && trace.error.status === 404;
  const detail: TelemetryRecordSummary & Partial<TelemetryEvent> =
    event.data ?? record;
  const cause = describeCause(detail.category, detail.code);
  const teammate = teammateName(detail.agentId, teammates);
  useVisibleHeight(panel);
  // The span is revealed once the details above it, which move it as they load, are in place.
  const reveal = useScrollReveal<HTMLDivElement>(
    record.source !== "events" || !event.isPending,
  );
  useEffect(() => {
    // Focus moves to the details without scrolling the list or page the record was chosen from.
    heading.current?.focus({ preventScroll: true });
  }, [record.id]);
  return (
    <aside
      id="telemetry-detail"
      ref={panel}
      className="telemetry-detail"
      aria-labelledby="telemetry-detail-heading"
    >
      <div className="telemetry-detail-header">
        <div>
          <SeverityBadge severity={detail.severity} />
          <h2 id="telemetry-detail-heading" ref={heading} tabIndex={-1}>
            {detail.title}
          </h2>
          <p>
            <time dateTime={detail.time}>{formatTime(detail.time)}</time> ·{" "}
            {typeLabel(detail.type)}
            {detail.durationMs !== null &&
              ` · ${formatDuration(detail.durationMs)}`}
          </p>
        </div>
        <IconButton label="Close details" onClick={onClose}>
          <X aria-hidden="true" />
        </IconButton>
      </div>
      <div
        className="telemetry-detail-body"
        ref={reveal.area}
        onScroll={reveal.onScroll}
      >
        {event.isPending && record.source === "events" && (
          <p className="telemetry-muted" role="status">
            Loading details…
          </p>
        )}
        {event.isError && (
          <div className="status-panel" role="alert">
            <p>
              These details couldn’t be loaded. They may be older than the
              retention period.
            </p>
            <Button variant="light" onClick={() => void event.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {cause && (
          <section className="telemetry-cause" aria-label="Cause">
            <p>{cause.summary}</p>
            {cause.nextStep && (
              <p className="telemetry-next-step">{cause.nextStep}</p>
            )}
          </section>
        )}
        <dl className="telemetry-facts">
          {detail.outcome && (
            <Fact label="Outcome" value={outcomeLabels[detail.outcome]} />
          )}
          {detail.category && <Fact label="Category" value={detail.category} />}
          {detail.code && <Fact label="Code" value={detail.code} />}
          {detail.httpStatus !== null && (
            <Fact label="HTTP status" value={String(detail.httpStatus)} />
          )}
          {detail.requestId && (
            <Fact label="Provider request ID" value={detail.requestId} />
          )}
          {detail.retryable !== undefined && detail.retryable !== null && (
            <Fact
              label="Retrying may help"
              value={detail.retryable ? "Yes" : "No"}
            />
          )}
          {detail.provider && (
            <Fact label="Provider" value={providerName(detail.provider)!} />
          )}
          {detail.model && <Fact label="Model" value={detail.model} />}
          {teammate && (
            <>
              <dt>Teammate</dt>
              <dd>
                {teammate}
                {teammate !== "Removed teammate" && (
                  <Link
                    className="telemetry-inline-link"
                    to={`/team/${encodeURIComponent(detail.agentId!)}`}
                  >
                    Open conversation
                    <ExternalLink aria-hidden="true" />
                  </Link>
                )}
              </dd>
            </>
          )}
          {detail.runId && <Fact label="Run ID" value={detail.runId} />}
          {detail.sessionId && (
            <Fact label="Session ID" value={detail.sessionId} />
          )}
          {detail.traceId && <Fact label="Trace ID" value={detail.traceId} />}
          {detail.details?.map((fact) => (
            <Fact key={fact.key} label={fact.label} value={fact.value} />
          ))}
        </dl>
        {detail.message ? (
          <section
            className="telemetry-message"
            aria-labelledby="telemetry-message-heading"
          >
            <h3 id="telemetry-message-heading">What the error said</h3>
            <p className="telemetry-muted">
              Credentials and query strings are removed before it’s stored. It
              can still quote what was sent, such as part of a prompt.
            </p>
            <pre>{detail.message}</pre>
          </section>
        ) : (
          detail.textWithheld && (
            <section
              className="telemetry-message"
              aria-labelledby="telemetry-message-heading"
            >
              <h3 id="telemetry-message-heading">Error text withheld</h3>
              <p className="telemetry-muted">
                What this error said wasn’t recorded, because the installation
                was withholding error text when it happened; that text can quote
                what was sent, such as part of a prompt. The cause and codes
                above come from the error’s structured details. Whoever manages
                the installation can turn on error text for later records; the
                deployment guide explains how.
              </p>
            </section>
          )
        )}
        {record.traceId &&
          (trace.isPending ? (
            <p className="telemetry-muted" role="status">
              Loading trace…
            </p>
          ) : !trace.data && traceMissing ? (
            <p className="telemetry-muted">
              No other records you can see belong to this trace.
            </p>
          ) : !trace.data ? (
            <div className="status-panel" role="alert">
              <p>The trace couldn’t be loaded. {trace.error?.message}</p>
              <Button variant="light" onClick={() => void trace.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              {trace.isError && (
                <div className="telemetry-notice telemetry-stale" role="alert">
                  <span>
                    The trace couldn’t be updated; it’s shown as last loaded.
                  </span>
                  <Button variant="light" onClick={() => void trace.refetch()}>
                    Try again
                  </Button>
                </div>
              )}
              <TraceTimeline
                trace={trace.data}
                highlightSpanId={
                  record.source === "spans" ? record.id : record.spanId
                }
                selectedEventId={record.source === "events" ? record.id : null}
                onSelectEvent={onSelect}
                targetRef={reveal.target}
              />
            </>
          ))}
      </div>
    </aside>
  );
}
