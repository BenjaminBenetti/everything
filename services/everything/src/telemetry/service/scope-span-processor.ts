import { SpanKind, SpanStatusCode, type Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type {
  TelemetryOutcome,
  TelemetrySeverity,
} from "@everything/telemetry-contracts";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import { scopeAttributes, telemetryScope } from "./telemetry-recorder.js";
import { traceOwners, type TraceOwners } from "./trace-owners.js";

/**
 * Attribute every span to the owner and teammate of the work it belongs to, including spans that
 * libraries start, such as database queries and outgoing requests, and classify it for the explorer.
 */
export class ScopeSpanProcessor implements SpanProcessor {
  // ===========================================
  // Construction
  // ===========================================

  /** Read request owners from the registry request authentication fills. */
  constructor(private readonly owners: TraceOwners = traceOwners) {}

  // ===========================================
  // Span lifecycle
  // ===========================================

  /** Copy the enclosing scope onto the span without replacing attributes it already has. */
  onStart(span: Span, parentContext: Context): void {
    try {
      const scope = telemetryScope(parentContext);
      if (scope) this.fill(span, scopeAttributes(scope));
      else this.fillFromRequest(span);
      if (span.attributes[attribute.type] === undefined) {
        if (span.kind === SpanKind.SERVER)
          span.setAttribute(attribute.type, "http");
        else if (span.kind === SpanKind.CLIENT)
          span.setAttribute(attribute.type, "dependency");
      }
    } catch {
      // The SDK calls processors without a guard; attribution never reaches the work being traced.
    }
  }

  /** Attribute spans that began before authentication, and record severity and outcome. */
  onEnding(span: Span): void {
    try {
      if (span.attributes[attribute.ownerId] === undefined)
        this.fillFromRequest(span);
      const { severity, outcome } = classify(span);
      span.setAttribute(attribute.severity, severity);
      span.setAttribute(attribute.outcome, outcome);
    } catch {
      // As in onStart.
    }
  }

  /** Nothing to do once the span has ended. */
  onEnd(_span: ReadableSpan): void {}

  /** Nothing is buffered here. */
  async forceFlush(): Promise<void> {}

  /** Nothing is held here. */
  async shutdown(): Promise<void> {}

  // ===========================================
  // Attribution
  // ===========================================

  /** Use the trace's request owner, if its request has been authenticated. */
  private fillFromRequest(span: Span): void {
    const owner = this.owners.get(span.spanContext().traceId);
    if (owner)
      this.fill(
        span,
        scopeAttributes({
          ownerId: owner.ownerId,
          ...(owner.agentId ? { agentId: owner.agentId } : {}),
        }),
      );
  }

  /** Set attributes the span does not already have. */
  private fill(
    span: Span,
    attributes: Readonly<Record<string, unknown>>,
  ): void {
    for (const [key, value] of Object.entries(attributes))
      if (span.attributes[key] === undefined && typeof value === "string")
        span.setAttribute(key, value);
  }
}

/** HTTP status attributes, under current and older semantic conventions. */
const statusAttributes = [attribute.httpStatus, "http.status_code"] as const;

/** A span's severity and outcome, from its status, HTTP status, and recorded outcome. */
function classify(span: Span): {
  severity: TelemetrySeverity;
  outcome: TelemetryOutcome;
} {
  const recorded = span.attributes[attribute.outcome];
  if (recorded === "cancelled" || aborted(span))
    return { severity: "info", outcome: "cancelled" };
  if (span.status.code === SpanStatusCode.ERROR)
    return { severity: "error", outcome: "failure" };
  const status = statusAttributes
    .map((key) => Number(span.attributes[key]))
    .find((value) => Number.isInteger(value) && value > 0);
  if (status !== undefined && status >= 500)
    return { severity: "error", outcome: "failure" };
  if (status !== undefined && status >= 400)
    return { severity: "warning", outcome: "failure" };
  return {
    severity: "info",
    outcome: recorded === "failure" ? "failure" : "success",
  };
}

/** Whether a failed span was cancelled, such as a request aborted with a reason of its own. */
function aborted(span: Span): boolean {
  if (span.status.code !== SpanStatusCode.ERROR) return false;
  return (
    span.attributes["error.type"] === "AbortError" ||
    /\babort/i.test(span.status.message ?? "") ||
    span.events.some(
      (event) =>
        event.name === "exception" &&
        event.attributes?.["exception.type"] === "AbortError",
    )
  );
}
