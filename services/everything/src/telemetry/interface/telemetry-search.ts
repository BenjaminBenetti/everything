/** OpenObserve's two record kinds in one stream: events as logs, spans as traces. */
export type TelemetryStreamType = "logs" | "traces";

/** One stored record, as the backend returns its columns. */
export type TelemetryRow = Readonly<Record<string, unknown>>;

/** A time window in microseconds since the epoch, the backend's time unit. */
export interface TelemetryWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * Read access to the telemetry backend for queries the application has already built and
 * scoped. No caller-supplied SQL reaches it.
 */
export interface TelemetrySearch {
  /** Run one query over a time window, returning at most `size` rows. */
  search(
    type: TelemetryStreamType,
    sql: string,
    window: TelemetryWindow,
    size: number,
  ): Promise<TelemetryRow[]>;
  /** The columns the stream has received; empty before its first record. */
  fields(type: TelemetryStreamType): Promise<ReadonlySet<string>>;
  /** Whether the backend answers with the configured credentials. */
  available(): Promise<boolean>;
}
