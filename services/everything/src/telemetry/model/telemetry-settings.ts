/**
 * Where Everything sends telemetry and reads it back: an OpenObserve server inside the cluster,
 * reached with credentials that stay in this process. Null settings turn telemetry off.
 */
export interface TelemetryBackendSettings {
  /** Base URL of the OpenObserve service, such as `http://openobserve:5080`. */
  readonly url: string;
  readonly organization: string;
  /** The stream that holds Everything's events and, separately typed, its spans. */
  readonly stream: string;
  readonly username: string;
  readonly password: string;
  /** Deadline for one export or query request. */
  readonly timeoutMs: number;
}

/** Telemetry configuration, validated once for the instrumentation preload and the API. */
export interface TelemetrySettings {
  /** Whether the deployment configures a telemetry backend at all. */
  readonly enabled: boolean;
  /** The configured backend; null when telemetry is off or its credentials cannot be read. */
  readonly backend: TelemetryBackendSettings | null;
  /** Rolling history the backend keeps, which also bounds the API's time ranges. */
  readonly retentionDays: number;
  /** Share of successful, quick read requests whose traces are kept; failures are always kept. */
  readonly readSampleRatio: number;
  /** Version reported as the service's, such as the chart's app version. */
  readonly serviceVersion: string;
  /**
   * Record the text of provider, SDK, and library error messages, redacted and bounded. On by
   * default, to explain failures; such text can quote what was sent, such as part of a prompt, which
   * no redaction can reliably recognize. Structured facts, such as categories, codes, statuses, and
   * request IDs, are recorded either way.
   */
  readonly includeErrorText: boolean;
  /**
   * Record previews of content, redacted for credentials and bounded: the message a teammate turn
   * answered, the arguments of tool calls, and SQL statements without their parameter values. On by
   * default, following `includeErrorText` unless set on its own.
   */
  readonly includeContent: boolean;
}
