import type {
  TelemetryEvent,
  TelemetryPage,
  TelemetryQuery,
  TelemetryStatus,
  TelemetryTrace,
} from "@everything/telemetry-contracts";

/** Browser access to the signed-in owner's telemetry; the API decides whose records are visible. */
export interface TelemetryClient {
  /** Whether telemetry is turned on and its storage is answering. */
  status(signal?: AbortSignal): Promise<TelemetryStatus>;
  /** A page of events, newest first. */
  events(query: TelemetryQuery, signal?: AbortSignal): Promise<TelemetryPage>;
  /** A page of spans, newest first. */
  spans(query: TelemetryQuery, signal?: AbortSignal): Promise<TelemetryPage>;
  /** One event with its diagnosis. */
  event(eventId: string, signal?: AbortSignal): Promise<TelemetryEvent>;
  /** The spans and events of one trace. */
  trace(traceId: string, signal?: AbortSignal): Promise<TelemetryTrace>;
}
