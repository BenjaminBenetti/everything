import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  defaultExportPolicy,
  errorTextLimit,
  exportableAttributes,
  exportedSpanEvents,
  withholdsContent,
  withholdsErrorText,
  type ExportPolicy,
} from "../service/telemetry-allowlist.js";
import type { ExportHealth } from "../service/export-health.js";
import { redactText } from "../service/telemetry-redactor.js";
import { traceOwners, type TraceOwners } from "../service/trace-owners.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";
import { isFixedStatus } from "../model/telemetry-statuses.js";

/** Longest span name or event summary, after redaction. */
const nameLimit = 200;

/** Most links exported for one span, as many as the SDK keeps. */
const linkLimit = 8;

/** W3C trace and span IDs as lowercase hexadecimal. */
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;

/** Whether `id` is a canonical, non-zero ID, the only kind a link is exported with. */
function canonicalId(id: unknown, pattern: RegExp): boolean {
  return typeof id === "string" && pattern.test(id) && !/^0+$/.test(id);
}

/**
 * Send spans with only allowlisted, redacted attributes and events, so nothing a library or SDK
 * error recorded leaves the process unless it is known to be safe. Error text, in status messages
 * and exception events, is left out unless `policy` records it; only Everything's own fixed status
 * messages are kept regardless. Content previews are left out unless `policy` records content.
 * Spans that ended before their request was authenticated, such as the session lookup, receive its
 * owner here, since batches are exported after the request has been. Batch outcomes are counted.
 */
export class RedactingSpanExporter implements SpanExporter {
  /** Wrap the backend's exporter, attributing spans from `owners`. */
  constructor(
    private readonly exporter: SpanExporter,
    private readonly health: ExportHealth,
    private readonly policy: ExportPolicy = defaultExportPolicy,
    private readonly owners: TraceOwners = traceOwners,
  ) {}

  /** Export safe views of the spans; a span that cannot be made safe fails the batch unsent. */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    let views: ReadableSpan[];
    try {
      views = spans.map((span) =>
        exportableSpan(span, this.policy, this.owners),
      );
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

/**
 * Send events with only allowlisted, redacted attributes, leaving error text out unless `policy`
 * records it, and counting batch outcomes.
 */
export class RedactingLogExporter implements LogRecordExporter {
  /** Wrap the backend's exporter. */
  constructor(
    private readonly exporter: LogRecordExporter,
    private readonly health: ExportHealth,
    private readonly policy: ExportPolicy = defaultExportPolicy,
  ) {}

  /** Export safe views of the records; a record that cannot be made safe fails the batch unsent. */
  export(
    records: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    let views: ReadableLogRecord[];
    try {
      views = records.map((record) => exportableLogRecord(record, this.policy));
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

/**
 * A view of the span, delegating to it, with its name, attributes, events, and status made safe.
 * A span whose error text or content `policy` left out is marked, so the explorer can say so. Its
 * links keep only the canonical IDs of the spans that started it, at most eight, so the explorer
 * can relate traces; any attributes or trace state a link carried are dropped, and so is a link
 * whose IDs aren't canonical, non-zero, lowercase hexadecimal.
 */
export function exportableSpan(
  span: ReadableSpan,
  policy: ExportPolicy = defaultExportPolicy,
  owners?: TraceOwners,
): ReadableSpan {
  const kept = span.events.filter((event) =>
    exportedSpanEvents.has(event.name),
  );
  const events = kept.map((event) => ({
    ...event,
    attributes: exportableAttributes(event.attributes ?? {}, policy),
  }));
  const message = span.status.message;
  const keepMessage =
    !!message && (policy.includeErrorText || isFixedStatus(message));
  const status = !message
    ? span.status
    : keepMessage
      ? { ...span.status, message: redactText(message, errorTextLimit) }
      : { code: span.status.code };
  const withheld =
    (!!message && !keepMessage) ||
    withholdsErrorText(span.attributes, policy) ||
    kept.some((event) => withholdsErrorText(event.attributes ?? {}, policy));
  const attributes = attributed(span, policy, owners);
  return Object.create(span, {
    name: { value: redactText(span.name, nameLimit) },
    attributes: {
      value: {
        ...attributes,
        ...(withheld ? { [attribute.textWithheld]: true } : {}),
        ...(withholdsContent(span.attributes, policy)
          ? { [attribute.contentWithheld]: true }
          : {}),
      },
    },
    events: { value: events },
    links: {
      value: span.links
        .filter(
          (link) =>
            canonicalId(link.context.traceId, traceIdPattern) &&
            canonicalId(link.context.spanId, spanIdPattern),
        )
        .slice(0, linkLimit)
        .map((link) => ({
          context: {
            traceId: link.context.traceId,
            spanId: link.context.spanId,
            traceFlags: link.context.traceFlags & 0xff,
          },
        })),
    },
    droppedEventsCount: {
      value: span.droppedEventsCount + span.events.length - events.length,
    },
    status: { value: status },
  }) as ReadableSpan;
}

/**
 * A view of the record, delegating to it, with its body and attributes made safe. Its body is the
 * title Everything gave the event. A record whose error text `policy` left out is marked.
 */
export function exportableLogRecord(
  record: ReadableLogRecord,
  policy: ExportPolicy = defaultExportPolicy,
): ReadableLogRecord {
  const attributes = exportableAttributes(record.attributes, policy);
  return Object.create(record, {
    body: {
      value:
        typeof record.body === "string"
          ? redactText(record.body, nameLimit)
          : undefined,
    },
    attributes: {
      value: withholdsErrorText(record.attributes, policy)
        ? { ...attributes, [attribute.textWithheld]: true }
        : attributes,
    },
  }) as ReadableLogRecord;
}

/** The span's safe attributes, with its request's owner when it ended unattributed. */
function attributed(
  span: ReadableSpan,
  policy: ExportPolicy,
  owners?: TraceOwners,
) {
  const attributes = exportableAttributes(span.attributes, policy);
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
