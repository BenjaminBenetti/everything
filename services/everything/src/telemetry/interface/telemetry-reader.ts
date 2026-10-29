import type {
  TelemetryEvent,
  TelemetryPage,
  TelemetryQuery,
  TelemetryStatus,
  TelemetryTrace,
} from "@everything/telemetry-contracts";

/**
 * Owner-scoped reading of telemetry for the API. Every operation takes the verified owner and
 * returns only that owner's records; missing and inaccessible records look the same.
 */
export interface TelemetryReader {
  /** Whether telemetry is turned on and its storage is answering, and this process's export health. */
  status(): Promise<TelemetryStatus>;
  /** A page of the owner's events, newest first. */
  events(ownerId: string, query: TelemetryQuery): Promise<TelemetryPage>;
  /** A page of the owner's spans, newest first. */
  spans(ownerId: string, query: TelemetryQuery): Promise<TelemetryPage>;
  /** One of the owner's events with its full diagnosis. */
  event(ownerId: string, eventId: string): Promise<TelemetryEvent>;
  /** The owner's spans and events in one trace. */
  trace(ownerId: string, traceId: string): Promise<TelemetryTrace>;
}
