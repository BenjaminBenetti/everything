import type {
  Attributes,
  Context,
  HrTime,
  SpanContext,
} from "@opentelemetry/api";
import type {
  LogRecordProcessor,
  ReadableLogRecord,
  ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { ExportHealth } from "../service/export-health.js";
import {
  defaultExportPolicy,
  type ExportPolicy,
} from "../service/telemetry-allowlist.js";
import { exportableLogRecord, exportableSpan } from "./redacting-exporters.js";

/**
 * Make each ended span safe before anything holds it. The read-request filter and the batch queue
 * after it receive a copy with only allowlisted, redacted attributes and events, and with error text
 * and content left out unless `policy` records them, exactly as the exporter would send it. The copy
 * is plain data of its own: it holds no reference to the SDK's span, its attributes, or its events,
 * so nothing it left out waits in a queue. A span that can't be made safe is dropped and counted,
 * never passed on raw or thrown into the work being traced. The exporter makes every span safe
 * again before it leaves the process, and attributes those that ended before their request was
 * authenticated.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  /** Pass safe copies to `next`, normally the read-request filter, counting drops in `health`. */
  constructor(
    private readonly next: SpanProcessor,
    private readonly health: ExportHealth,
    private readonly policy: ExportPolicy = defaultExportPolicy,
  ) {}

  /** Pass a starting span on; the processors after this one read it there but never hold it. */
  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
  }

  /** Pass on a safe copy of the ended span. */
  onEnd(span: ReadableSpan): void {
    let safe: ReadableSpan;
    try {
      safe = detachedSpan(exportableSpan(span, this.policy));
    } catch {
      this.health.discarded(1);
      return;
    }
    this.next.onEnd(safe);
  }

  /** Flush the processors after this one. */
  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  /** Shut down the processors after this one. */
  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

/**
 * Make each event record safe before the batch queue holds it, as `RedactingSpanProcessor` does for
 * spans: `next`, which only queues and exports records, receives a detached copy with a redacted
 * body and allowlisted, redacted attributes, and error text left out unless `policy` records it.
 */
export class RedactingLogRecordProcessor implements LogRecordProcessor {
  /** Pass safe copies to `next`, normally the batch processor, counting drops in `health`. */
  constructor(
    private readonly next: LogRecordProcessor,
    private readonly health: ExportHealth,
    private readonly policy: ExportPolicy = defaultExportPolicy,
  ) {}

  /** Pass on a safe copy of the emitted record. */
  onEmit(record: ReadWriteLogRecord, context?: Context): void {
    let safe: ReadableLogRecord;
    try {
      safe = detachedLogRecord(exportableLogRecord(record, this.policy));
    } catch {
      this.health.discarded(1);
      return;
    }
    // The batch processor only queues the record and exports it; nothing writes to it.
    this.next.onEmit(safe as ReadWriteLogRecord, context);
  }

  /** Flush the processor after this one. */
  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  /** Shut down the processor after this one. */
  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

// ===========================================
// Detached copies
// ===========================================

/** A span's safe view copied into plain data, read once. */
function detachedSpan(view: ReadableSpan): ReadableSpan {
  const context = contextCopy(view.spanContext());
  return Object.freeze({
    name: view.name,
    kind: view.kind,
    spanContext: () => context,
    ...(view.parentSpanContext
      ? { parentSpanContext: contextCopy(view.parentSpanContext) }
      : {}),
    startTime: timeCopy(view.startTime),
    endTime: timeCopy(view.endTime),
    duration: timeCopy(view.duration),
    status:
      view.status.message === undefined
        ? { code: view.status.code }
        : { code: view.status.code, message: view.status.message },
    attributes: attributesCopy(view.attributes),
    links: view.links.map((link) => ({ context: contextCopy(link.context) })),
    events: view.events.map((event) => ({
      name: event.name,
      time: timeCopy(event.time),
      attributes: attributesCopy(event.attributes ?? {}),
      droppedAttributesCount: event.droppedAttributesCount ?? 0,
    })),
    ended: view.ended,
    resource: view.resource,
    instrumentationScope: view.instrumentationScope,
    droppedAttributesCount: view.droppedAttributesCount,
    droppedEventsCount: view.droppedEventsCount,
    droppedLinksCount: view.droppedLinksCount,
  });
}

/** An event record's safe view copied into plain data, read once. */
function detachedLogRecord(view: ReadableLogRecord): ReadableLogRecord {
  return Object.freeze({
    hrTime: timeCopy(view.hrTime),
    hrTimeObserved: timeCopy(view.hrTimeObserved),
    ...(view.spanContext ? { spanContext: contextCopy(view.spanContext) } : {}),
    ...(view.severityText === undefined
      ? {}
      : { severityText: view.severityText }),
    ...(view.severityNumber === undefined
      ? {}
      : { severityNumber: view.severityNumber }),
    ...(typeof view.body === "string" ? { body: view.body } : {}),
    ...(view.eventName === undefined ? {} : { eventName: view.eventName }),
    resource: view.resource,
    instrumentationScope: view.instrumentationScope,
    attributes: attributesCopy(view.attributes),
    droppedAttributesCount: view.droppedAttributesCount,
  });
}

/** A span context's IDs and flags, and its trace state as the SDK keeps it. */
function contextCopy(context: SpanContext): SpanContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    ...(context.isRemote === undefined ? {} : { isRemote: context.isRemote }),
    ...(context.traceState ? { traceState: context.traceState } : {}),
  };
}

/** A time as a new pair. */
function timeCopy(time: HrTime): HrTime {
  return [time[0], time[1]];
}

/** Attributes as a new object, with any list value as a new list. */
function attributesCopy(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  ) as Attributes;
}
