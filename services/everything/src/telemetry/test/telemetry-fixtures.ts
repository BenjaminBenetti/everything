import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import {
  startTelemetry,
  type TelemetryRuntimeOptions,
} from "../factory/telemetry-runtime.js";
import { telemetryAttributes as attribute } from "../model/telemetry-attributes.js";

/** What the process exported, after allowlisting and redaction, as tests inspect it. */
export interface ExportedTelemetry {
  readonly spans: ReadableSpan[];
  readonly events: ReadableLogRecord[];
}

/**
 * Start the process's telemetry with in-memory exporters behind the same redacting exporters,
 * processors, and filters production uses, withholding error text unless `includeErrorText`. Node
 * runs each test file in its own process, so each file starts it once.
 */
export function startInMemoryTelemetry({
  includeErrorText = false,
  ...options
}: Omit<TelemetryRuntimeOptions, "spanExporter" | "logExporter"> & {
  readonly includeErrorText?: boolean;
} = {}) {
  const spans = new InMemorySpanExporter();
  const events = new InMemoryLogRecordExporter();
  const runtime = startTelemetry(
    {
      enabled: true,
      backend: null,
      retentionDays: 7,
      readSampleRatio: 0,
      serviceVersion: "test",
      includeErrorText,
    },
    {
      instrument: false,
      batchDelayMs: 5,
      ...options,
      spanExporter: spans,
      logExporter: events,
    },
  )!;
  return {
    runtime,
    /** Export everything recorded so far and return all exported records. */
    async collect(): Promise<ExportedTelemetry> {
      await runtime.flush();
      return {
        spans: spans.getFinishedSpans(),
        events: events.getFinishedLogRecords(),
      };
    },
    /** Forget what has been exported. */
    reset(): void {
      spans.reset();
      events.reset();
    },
  };
}

/** Exported events with the given name. */
export function eventsNamed(
  exported: ExportedTelemetry,
  name: string,
): ReadableLogRecord[] {
  return exported.events.filter(
    (event) => event.attributes[attribute.event] === name,
  );
}

/** Exported spans with the given name. */
export function spansNamed(
  exported: ExportedTelemetry,
  name: string,
): ReadableSpan[] {
  return exported.spans.filter((span) => span.name === name);
}

/** Every string an export would carry, for checking that secrets never appear in any of them. */
export function exportedText(exported: ExportedTelemetry): string {
  return JSON.stringify({
    spans: exported.spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
    })),
    events: exported.events.map((event) => ({
      body: event.body,
      attributes: event.attributes,
    })),
  });
}
