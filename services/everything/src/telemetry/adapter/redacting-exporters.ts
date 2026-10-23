import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  exportableAttributes,
  exportedSpanEvents,
} from "../service/telemetry-allowlist.js";
import type { ExportHealth } from "../service/export-health.js";
import { redactText } from "../service/telemetry-redactor.js";
import { traceOwners, type TraceOwners } from "../service/trace-owners.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";

/** Longest span name or event summary, after redaction. */
const nameLimit = 200;

/** Longest span status message, after redaction. */
const statusLimit = 400;

/**
 * Send spans with only allowlisted, redacted attributes and events, so nothing a library or SDK
 * error recorded leaves the process unless it is known to be safe. Spans that ended before their
 * request was authenticated, such as the session lookup, receive its owner here, since batches are
 * exported after the request has been. Batch outcomes are counted.
 */
export class RedactingSpanExporter implements SpanExporter {
  /** Wrap the backend's exporter, attributing spans from `owners`. */
  constructor(
    private readonly exporter: SpanExporter,
    private readonly health: ExportHealth,
    private readonly owners: TraceOwners = traceOwners,
  ) {}

  /** Export safe views of the spans; a span that cannot be made safe fails the batch unsent. */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    let views: ReadableSpan[];
    try {
      views = spans.map((span) => exportableSpan(span, this.owners));
    } catch {
      this.health.failed();
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    this.exporter.export(views, (result) => {
      if (result.code === ExportResultCode.SUCCESS) this.health.succeeded();
      else this.health.failed();
      resultCallback(result);
    });
  }

  /** Stop the backend's exporter. */
  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  /** Flush the backend's exporter. */
  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }
}

/** Send events with only allowlisted, redacted attributes, counting batch outcomes. */
export class RedactingLogExporter implements LogRecordExporter {
  /** Wrap the backend's exporter. */
  constructor(
    private readonly exporter: LogRecordExporter,
    private readonly health: ExportHealth,
  ) {}

  /** Export safe views of the records; a record that cannot be made safe fails the batch unsent. */
  export(
    records: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    let views: ReadableLogRecord[];
    try {
      views = records.map(exportableLogRecord);
    } catch {
      this.health.failed();
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    this.exporter.export(views, (result) => {
      if (result.code === ExportResultCode.SUCCESS) this.health.succeeded();
      else this.health.failed();
      resultCallback(result);
    });
  }

  /** Stop the backend's exporter. */
  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  /** Flush the backend's exporter. */
  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }
}

/** A view of the span, delegating to it, with its name, attributes, events, and status made safe. */
export function exportableSpan(
  span: ReadableSpan,
  owners?: TraceOwners,
): ReadableSpan {
  const events = span.events
    .filter((event) => exportedSpanEvents.has(event.name))
    .map((event) => ({
      ...event,
      attributes: exportableAttributes(event.attributes ?? {}),
    }));
  const status = span.status.message
    ? { ...span.status, message: redactText(span.status.message, statusLimit) }
    : span.status;
  return Object.create(span, {
    name: { value: redactText(span.name, nameLimit) },
    attributes: { value: attributed(span, owners) },
    events: { value: events },
    droppedEventsCount: {
      value: span.droppedEventsCount + span.events.length - events.length,
    },
    status: { value: status },
  }) as ReadableSpan;
}

/** A view of the record, delegating to it, with its body and attributes made safe. */
export function exportableLogRecord(
  record: ReadableLogRecord,
): ReadableLogRecord {
  return Object.create(record, {
    body: {
      value:
        typeof record.body === "string"
          ? redactText(record.body, nameLimit)
          : undefined,
    },
    attributes: { value: exportableAttributes(record.attributes) },
  }) as ReadableLogRecord;
}

/** The span's safe attributes, with its request's owner when it ended unattributed. */
function attributed(span: ReadableSpan, owners?: TraceOwners) {
  const attributes = exportableAttributes(span.attributes);
  if (attributes[attribute.ownerId] !== undefined || !owners) return attributes;
  const owner = owners.get(span.spanContext().traceId);
  if (!owner) return attributes;
  return {
    ...attributes,
    [attribute.ownerId]: owner.ownerId,
    ...(owner.agentId && attributes[attribute.agentId] === undefined
      ? { [attribute.agentId]: owner.agentId }
      : {}),
  };
}
