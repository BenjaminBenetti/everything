import { context, logs, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import type { TelemetryExportHealth } from "@everything/telemetry-contracts";
import { DropCountingMeterProvider } from "../adapter/drop-counting-meter-provider.js";
import {
  RedactingLogExporter,
  RedactingSpanExporter,
} from "../adapter/redacting-exporters.js";
import {
  RedactingLogRecordProcessor,
  RedactingSpanProcessor,
} from "../adapter/redacting-processors.js";
import type {
  TelemetryBackendSettings,
  TelemetrySettings,
} from "../model/telemetry-settings.js";
import {
  DatabaseStatementProcessor,
  shapeQueryStatement,
} from "../service/database-statement-processor.js";
import { ExportHealth } from "../service/export-health.js";
import {
  defaultReadRequestPolicy,
  ReadRequestFilter,
} from "../service/read-request-filter.js";
import { ScopeSpanProcessor } from "../service/scope-span-processor.js";
import { attributeValueLengthLimit } from "../model/telemetry-attributes.js";

/** The process's started telemetry: its export health, and flushing for shutdown. */
export interface TelemetryRuntime {
  /** What has been sent to telemetry storage since the process started. */
  health(): TelemetryExportHealth;
  /** Export everything recorded so far, within the export deadline. */
  flush(): Promise<void>;
  /** Export what remains and stop; later records are dropped. */
  shutdown(): Promise<void>;
}

/** Replaceable parts for tests; production uses the configured backend and every instrumentation. */
export interface TelemetryRuntimeOptions {
  readonly spanExporter?: SpanExporter;
  readonly logExporter?: LogRecordExporter;
  /** Instrument incoming HTTP requests, fetch, and PostgreSQL; on by default. */
  readonly instrument?: boolean;
  /** Longest a record waits in its batch before export. */
  readonly batchDelayMs?: number;
  /** Most records each export queue holds while the backend is slow or unreachable. */
  readonly queueSize?: number;
  readonly random?: () => number;
}

/** The runtime started in this process, shared by the preload and the API's composition root. */
let active: TelemetryRuntime | undefined;

/** The started runtime, if telemetry is on in this process. */
export function activeTelemetry(): TelemetryRuntime | undefined {
  return active;
}

/**
 * Start tracing and event export to the configured backend, once per process, before the modules
 * it instruments are loaded. Export is bounded and asynchronous: a slow or unreachable backend fills
 * fixed-size queues whose overflow is counted and dropped, and never delays or fails the
 * application's work. Records are made safe before anything holds them, as they are again before
 * export: error text and content previews are kept only if the settings record them, and the
 * queues hold detached, redacted copies rather than the SDK's records. Without a backend nothing is
 * started and the API's calls do nothing.
 */
export function startTelemetry(
  settings: TelemetrySettings,
  options: TelemetryRuntimeOptions = {},
): TelemetryRuntime | undefined {
  if (active) return active;
  const backend = settings.backend;
  if (!backend && !(options.spanExporter && options.logExporter))
    return undefined;
  const health = new ExportHealth(Date.now, (state) =>
    console.warn(
      state === "failing"
        ? "Telemetry could not be exported; Everything keeps working and will retry."
        : "Telemetry export has recovered.",
    ),
  );
  const meters = new DropCountingMeterProvider(health);
  const queueSize = options.queueSize ?? 2048;
  const delay = options.batchDelayMs ?? 2_000;
  const timeout = backend?.timeoutMs ?? 10_000;
  const resource = resourceFromAttributes({
    "service.name": "everything",
    "service.version": settings.serviceVersion,
  });
  const policy = {
    includeErrorText: settings.includeErrorText,
    includeContent: settings.includeContent,
  };
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  const spans = new BatchSpanProcessor({
    exporter: new RedactingSpanExporter(
      options.spanExporter ?? traceExporter(backend!),
      health,
      policy,
    ),
    maxQueueSize: queueSize,
    maxExportBatchSize: Math.min(256, queueSize),
    scheduledDelayMillis: delay,
    exportTimeoutMillis: timeout,
    selfObsMeterProvider: meters,
  });
  const tracerProvider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanLimits: {
      attributeCountLimit: 64,
      attributeValueLengthLimit,
      eventCountLimit: 64,
      linkCountLimit: 8,
    },
    spanProcessors: [
      new ScopeSpanProcessor(),
      new DatabaseStatementProcessor(),
      new RedactingSpanProcessor(
        new ReadRequestFilter(
          spans,
          {
            ...defaultReadRequestPolicy,
            sampleRatio: settings.readSampleRatio,
          },
          options.random,
        ),
        health,
        policy,
      ),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    logRecordLimits: {
      attributeCountLimit: 64,
      attributeValueLengthLimit,
    },
    processors: [
      new RedactingLogRecordProcessor(
        new BatchLogRecordProcessor({
          exporter: new RedactingLogExporter(
            options.logExporter ?? logExporter(backend!),
            health,
            policy,
          ),
          maxQueueSize: Math.min(1024, queueSize),
          maxExportBatchSize: Math.min(128, queueSize),
          scheduledDelayMillis: Math.min(1_000, delay),
          exportTimeoutMillis: timeout,
          selfObsMeterProvider: meters,
        }),
        health,
        policy,
      ),
    ],
  });
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  if (options.instrument ?? true)
    registerInstrumentations({
      tracerProvider,
      instrumentations: [
        // Only API routes: health probes and static paths would be noise.
        new HttpInstrumentation({
          disableOutgoingRequestInstrumentation: true,
          ignoreIncomingRequestHook: (request) =>
            !(request.url ?? "").startsWith("/v1/"),
        }),
        // fetch, including provider requests; only inside traced work, so pollers stay quiet.
        new UndiciInstrumentation({ requireParentforSpans: true }),
        // Queries are named by operation. Their statements are replaced by their shape, without
        // literals, as each query starts, and exported only when the installation records content.
        // Parameter values are never collected, and nothing is added to the queries that run.
        new PgInstrumentation({
          requireParentSpan: true,
          enhancedDatabaseReporting: false,
          ignoreConnectSpans: true,
          requestHook: (span, { query }) =>
            shapeQueryStatement(span, query.text),
        }),
      ],
    });
  const runtime: TelemetryRuntime = {
    health: () => health.snapshot(),
    flush: async () => {
      await Promise.allSettled([
        tracerProvider.forceFlush(),
        loggerProvider.forceFlush(),
      ]);
    },
    shutdown: async () => {
      await Promise.allSettled([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
  active = runtime;
  return runtime;
}

/** Credentials and stream for OpenObserve's OTLP endpoints. */
function backendHeaders(
  backend: TelemetryBackendSettings,
): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${backend.username}:${backend.password}`).toString("base64")}`,
    "stream-name": backend.stream,
  };
}

/** OTLP over HTTP to OpenObserve's traces endpoint. */
function traceExporter(backend: TelemetryBackendSettings): SpanExporter {
  return new OTLPTraceExporter({
    url: `${backend.url}/api/${backend.organization}/v1/traces`,
    headers: backendHeaders(backend),
    timeoutMillis: backend.timeoutMs,
    concurrencyLimit: 4,
  });
}

/** OTLP over HTTP to OpenObserve's logs endpoint. */
function logExporter(backend: TelemetryBackendSettings): LogRecordExporter {
  return new OTLPLogExporter({
    url: `${backend.url}/api/${backend.organization}/v1/logs`,
    headers: backendHeaders(backend),
    timeoutMillis: backend.timeoutMs,
    concurrencyLimit: 4,
  });
}
