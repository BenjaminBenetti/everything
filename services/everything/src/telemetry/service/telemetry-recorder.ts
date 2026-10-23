import { randomUUID } from "node:crypto";
import {
  context,
  createContextKey,
  isSpanContextValid,
  logs,
  SeverityNumber,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";
import type {
  TelemetryOutcome,
  TelemetrySeverity,
  TelemetryType,
} from "@everything/telemetry-contracts";
import {
  telemetryAttributes as attribute,
  type telemetryEvents,
} from "../model/telemetry-attributes.js";
import type { TelemetryScope } from "../model/telemetry-scope.js";
import { traceOwners } from "./trace-owners.js";
import {
  describeError,
  redactText,
  safeIdentifier,
  type ErrorDescription,
} from "./telemetry-redactor.js";

/**
 * Everything's own spans and events, written through the OpenTelemetry API. Without a started
 * telemetry runtime the API does nothing, so callers never check whether telemetry is on, and no
 * recording failure ever reaches the work being recorded.
 */
const instrumentation = "everything";

/** Where the current work's scope lives in OpenTelemetry's context. */
const scopeKey = createContextKey("everything.telemetry.scope");

/** Longest event message, after redaction. */
const messageLimit = 400;

/** OpenTelemetry severities for the explorer's three levels. */
const severityNumbers: Readonly<Record<TelemetrySeverity, SeverityNumber>> = {
  error: SeverityNumber.ERROR,
  warning: SeverityNumber.WARN,
  info: SeverityNumber.INFO,
};

// ===========================================
// Scope
// ===========================================

/** The owner and teammate the work in a context belongs to, if server code has set them. */
export function telemetryScope(
  current: Context = context.active(),
): TelemetryScope | undefined {
  return current.getValue(scopeKey) as TelemetryScope | undefined;
}

/**
 * A context whose work belongs to `scope`. Details of the same owner's enclosing scope are kept
 * unless replaced; a different owner replaces the scope entirely, so records never mix owners.
 */
export function withTelemetryScope(
  scope: TelemetryScope,
  current: Context = context.active(),
): Context {
  const enclosing = telemetryScope(current);
  return current.setValue(
    scopeKey,
    enclosing?.ownerId === scope.ownerId ? { ...enclosing, ...scope } : scope,
  );
}

/**
 * A context for work that is not part of the enclosing run, such as a private message a turn sent:
 * its scope keeps the owner and teammate but not the run.
 */
export function withoutRun(current: Context = context.active()): Context {
  const scope = telemetryScope(current);
  if (!scope?.runId) return current;
  const { runId: _runId, ...rest } = scope;
  return current.setValue(scopeKey, rest);
}

/** A scope as record attributes. */
export function scopeAttributes(scope: TelemetryScope): Attributes {
  const entries: [string, string | undefined][] = [
    [attribute.ownerId, scope.ownerId],
    [attribute.agentId, scope.agentId],
    [attribute.sessionId, scope.sessionId],
    [attribute.sessionKind, scope.sessionKind],
    [attribute.parentSessionId, scope.parentSessionId],
    [attribute.runId, scope.runId],
    [attribute.provider, scope.provider],
    [attribute.model, scope.model],
  ];
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] => !!entry[1]),
  );
}

/**
 * Attribute the active request's trace to its verified owner, and to the teammate its route names,
 * so its spans, including those that began before authentication, are visible only to that owner.
 */
export function bindRequestOwner(ownerId: string, agentId?: string): void {
  try {
    const span = trace.getActiveSpan();
    if (!span || !span.isRecording()) return;
    span.setAttributes(
      scopeAttributes({ ownerId, ...(agentId ? { agentId } : {}) }),
    );
    traceOwners.set(span.spanContext().traceId, ownerId, agentId);
  } catch {
    // Attribution is best-effort; an unattributed span is visible to nobody.
  }
}

// ===========================================
// Spans
// ===========================================

/** How to start one of Everything's own spans. */
export interface TelemetrySpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  /** Narrow the scope for this span and the work inside it. */
  readonly scope?: TelemetryScope;
  /**
   * Start a new trace linked to the active span, for work that outlives what started it. Its
   * scope, when given, replaces the enclosing one.
   */
  readonly root?: boolean;
}

/** Start a span and return it with the context its work should run in. */
export function startTelemetrySpan(
  name: string,
  options: TelemetrySpanOptions = {},
  current: Context = context.active(),
): { span: Span; context: Context } {
  const active = trace.getSpan(current)?.spanContext();
  const links: Link[] =
    options.root && active && isSpanContextValid(active)
      ? [{ context: active }]
      : [];
  const parent = options.root ? trace.deleteSpan(current) : current;
  // A new trace is new work: its scope replaces the enclosing one rather than adding to it.
  const scoped = options.scope
    ? options.root
      ? parent.setValue(scopeKey, options.scope)
      : withTelemetryScope(options.scope, parent)
    : parent;
  const span = trace.getTracer(instrumentation).startSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.attributes ? { attributes: options.attributes } : {}),
      links,
      ...(options.root ? { root: true } : {}),
    },
    scoped,
  );
  return { span, context: trace.setSpan(scoped, span) };
}

/** Run `work` inside a new span, ending it when the work settles and marking a failure. */
export async function inTelemetrySpan<T>(
  name: string,
  options: TelemetrySpanOptions,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  const { span, context: spanContext } = startTelemetrySpan(name, options);
  try {
    return await context.with(spanContext, () => work(span));
  } catch (error) {
    failTelemetrySpan(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** Mark a span failed with a redacted description of the error, or cancelled without one. */
export function failTelemetrySpan(
  span: Span,
  error: unknown,
  outcome: "failure" | "cancelled" = "failure",
): void {
  try {
    span.setAttribute(attribute.outcome, outcome);
    if (outcome === "cancelled") return;
    const description = describeError(error);
    span.addEvent("exception", {
      "exception.type": description.type ?? "Error",
      ...(description.message
        ? { "exception.message": description.message }
        : {}),
    });
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(description.message ? { message: description.message } : {}),
    });
  } catch {
    // A span that cannot be marked keeps its default status.
  }
}

// ===========================================
// Events
// ===========================================

/** An event's facts. The recorder adds an ID, the scope, and the active trace, and redacts text. */
export interface TelemetryEventInput {
  readonly name: (typeof telemetryEvents)[keyof typeof telemetryEvents];
  /** A fixed summary written by Everything, never provider or user text. */
  readonly title: string;
  readonly type: TelemetryType;
  readonly severity: TelemetrySeverity;
  readonly outcome?: TelemetryOutcome;
  readonly category?: string;
  readonly code?: string;
  readonly message?: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly error?: ErrorDescription;
  /** Further facts, by the names in `telemetryAttributes`. */
  readonly attributes?: Attributes;
  /** The scope, when it is not the active context's. */
  readonly scope?: TelemetryScope;
}

/**
 * Record a durable event, such as a model failure, independently of trace sampling. It carries the
 * active trace and span, so the explorer can show it beside the work it happened in.
 */
export function recordTelemetryEvent(
  input: TelemetryEventInput,
  current: Context = context.active(),
): void {
  try {
    const scope = input.scope ?? telemetryScope(current);
    const code = safeIdentifier(input.code ?? input.error?.code, 64);
    const requestId = safeIdentifier(input.requestId);
    const message = input.message ?? input.error?.message;
    const status = input.httpStatus ?? input.error?.status;
    // The scope, which only server code sets, always wins over further facts.
    const attributes: Attributes = {
      ...input.attributes,
      ...(scope ? scopeAttributes(scope) : {}),
      [attribute.event]: input.name,
      [attribute.eventId]: randomUUID(),
      [attribute.type]: input.type,
      [attribute.severity]: input.severity,
      ...(input.outcome ? { [attribute.outcome]: input.outcome } : {}),
      ...(input.category ? { [attribute.category]: input.category } : {}),
      ...(code ? { [attribute.code]: code } : {}),
      ...(message
        ? { [attribute.message]: redactText(message, messageLimit) }
        : {}),
      ...(status !== undefined ? { [attribute.httpStatus]: status } : {}),
      ...(requestId ? { [attribute.requestId]: requestId } : {}),
      ...(input.retryable !== undefined
        ? { [attribute.retryable]: input.retryable }
        : {}),
      ...(input.error?.type ? { [attribute.errorType]: input.error.type } : {}),
      ...(input.error?.stack ? { [attribute.stack]: input.error.stack } : {}),
    };
    logs.getLogger(instrumentation).emit({
      eventName: input.name,
      severityNumber: severityNumbers[input.severity],
      severityText: input.severity.toUpperCase(),
      body: input.title,
      attributes,
      context: current,
    });
  } catch {
    // Telemetry never changes the outcome of the work it describes.
  }
}
