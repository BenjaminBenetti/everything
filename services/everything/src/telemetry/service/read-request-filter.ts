import { SpanKind, SpanStatusCode, type Context } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";

/** How quiet read requests are thinned out. */
export interface ReadRequestPolicy {
  /** Share of successful, quick reads whose traces are kept. */
  readonly sampleRatio: number;
  /** Reads at least this slow are always kept. */
  readonly slowMs: number;
  /** Most read traces held at once while their requests run; more are kept unfiltered. */
  readonly maxTraces: number;
  /** Most spans held for one read trace; a longer trace is kept unfiltered. */
  readonly maxSpansPerTrace: number;
  /** Longest a read trace is held for a request that never ends. */
  readonly maxAgeMs: number;
}

/** Defaults sized for the browser's polling of a few endpoints every few seconds. */
export const defaultReadRequestPolicy: Omit<ReadRequestPolicy, "sampleRatio"> =
  {
    slowMs: 2_000,
    maxTraces: 512,
    maxSpansPerTrace: 128,
    maxAgeMs: 60_000,
  };

/** Spans of one read request held until its server span ends. */
interface HeldTrace {
  readonly rootSpanId: string;
  readonly heldAt: number;
  readonly spans: ReadableSpan[];
  /** Whether any span in the request failed, such as a query the request recovered from. */
  failed: boolean;
}

/** HTTP method attributes, under current and older semantic conventions. */
const methodAttributes = [attribute.httpMethod, "http.method"] as const;

/** HTTP status attributes, under current and older semantic conventions. */
const statusAttributes = [attribute.httpStatus, "http.status_code"] as const;

/**
 * Keep the browser's frequent polling from crowding out what matters. A GET or HEAD request's spans
 * are held until its server span ends; reads that failed, returned a client error, were slow, or
 * contain a failed span, such as a query the request recovered from, are always passed on with
 * every child span, and other reads only at the sampling ratio. Every other trace passes through at
 * once. Events, such as failures, are recorded separately and never filtered.
 */
export class ReadRequestFilter implements SpanProcessor {
  // ===========================================
  // State and construction
  // ===========================================

  private readonly held = new Map<string, HeldTrace>();

  /** Pass kept spans to `next`, normally a batching exporter. */
  constructor(
    private readonly next: SpanProcessor,
    private readonly policy: ReadRequestPolicy,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = () => performance.now(),
  ) {}

  // ===========================================
  // Span lifecycle
  // ===========================================

  /** Start holding the trace of an incoming read request. */
  onStart(span: Span, parentContext: Context): void {
    try {
      this.hold(span);
    } catch {
      // Filtering never reaches the work being traced; an unheld trace passes through.
    }
    this.next.onStart(span, parentContext);
  }

  /** Start holding a read request's trace, if there is room. */
  private hold(span: Span): void {
    this.releaseExpired();
    if (
      span.kind === SpanKind.SERVER &&
      !span.parentSpanContext &&
      isRead(span) &&
      this.held.size < this.policy.maxTraces
    )
      this.held.set(span.spanContext().traceId, {
        rootSpanId: span.spanContext().spanId,
        heldAt: this.now(),
        spans: [],
        failed: false,
      });
  }

  /** Hold a read trace's spans until its request ends, then keep or drop them together. */
  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    const trace = this.held.get(traceId);
    if (!trace) {
      this.next.onEnd(span);
      return;
    }
    if (span.spanContext().spanId === trace.rootSpanId) {
      this.held.delete(traceId);
      if (trace.failed || this.keep(span)) this.pass([...trace.spans, span]);
      return;
    }
    trace.spans.push(span);
    if (span.status.code === SpanStatusCode.ERROR) trace.failed = true;
    if (trace.spans.length >= this.policy.maxSpansPerTrace)
      this.release(traceId);
  }

  /** Pass on held traces, then flush the next processor. */
  async forceFlush(): Promise<void> {
    for (const traceId of [...this.held.keys()]) this.release(traceId);
    await this.next.forceFlush();
  }

  /** Pass on held traces, then shut down the next processor. */
  async shutdown(): Promise<void> {
    for (const traceId of [...this.held.keys()]) this.release(traceId);
    await this.next.shutdown();
  }

  // ===========================================
  // Decisions
  // ===========================================

  /** Keep failures, client errors, slow reads, and a sample of the rest. */
  private keep(root: ReadableSpan): boolean {
    if (root.status.code === SpanStatusCode.ERROR) return true;
    const status = statusAttributes
      .map((key) => Number(root.attributes[key]))
      .find((value) => Number.isInteger(value) && value > 0);
    if (status === undefined || status >= 400) return true;
    if (hrTimeToMilliseconds(root.duration) >= this.policy.slowMs) return true;
    return this.random() < this.policy.sampleRatio;
  }

  /** Stop holding a trace, passing its spans on unfiltered, along with any it receives later. */
  private release(traceId: string): void {
    const trace = this.held.get(traceId);
    if (!trace) return;
    this.held.delete(traceId);
    this.pass(trace.spans);
  }

  /** Pass on traces held longer than any request should take. */
  private releaseExpired(): void {
    const cutoff = this.now() - this.policy.maxAgeMs;
    for (const [traceId, trace] of this.held) {
      if (trace.heldAt > cutoff) return;
      this.release(traceId);
    }
  }

  /** Hand spans to the next processor. */
  private pass(spans: readonly ReadableSpan[]): void {
    for (const span of spans) this.next.onEnd(span);
  }
}

/** Whether a server span is a GET or HEAD request. */
function isRead(span: Span): boolean {
  const method = methodAttributes
    .map((key) => span.attributes[key])
    .find((value) => typeof value === "string");
  return method === "GET" || method === "HEAD";
}
