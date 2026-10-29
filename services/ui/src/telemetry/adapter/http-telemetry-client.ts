import type {
  TelemetryEvent,
  TelemetryPage,
  TelemetryQuery,
  TelemetryStatus,
  TelemetryTrace,
} from "@everything/telemetry-contracts";
import type { JsonTransport } from "../../http/interface/json-transport.js";
import { HttpRequestError } from "../../http/model/http-request-error.js";
import type { TelemetryClient } from "../interface/telemetry-client.js";

/** Read telemetry through the authenticated same-origin API; no backend address or credential is known here. */
export class HttpTelemetryClient implements TelemetryClient {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive authentication and error policy independently of telemetry. */
  constructor(private readonly transport: JsonTransport) {}

  // ===========================================
  // Operations
  // ===========================================

  /** Ask whether telemetry is on and answering. */
  status(signal?: AbortSignal): Promise<TelemetryStatus> {
    return this.read("/v1/telemetry/status", signal);
  }

  /** Fetch a page of events matching `query`. */
  events(query: TelemetryQuery, signal?: AbortSignal): Promise<TelemetryPage> {
    return this.read(`/v1/telemetry/events${queryString(query)}`, signal);
  }

  /** Fetch a page of spans matching `query`. */
  spans(query: TelemetryQuery, signal?: AbortSignal): Promise<TelemetryPage> {
    return this.read(`/v1/telemetry/spans${queryString(query)}`, signal);
  }

  /** Fetch one event's diagnosis. */
  event(eventId: string, signal?: AbortSignal): Promise<TelemetryEvent> {
    return this.read(
      `/v1/telemetry/events/${encodeURIComponent(eventId)}`,
      signal,
    );
  }

  /** Fetch one trace. */
  trace(traceId: string, signal?: AbortSignal): Promise<TelemetryTrace> {
    return this.read(
      `/v1/telemetry/traces/${encodeURIComponent(traceId)}`,
      signal,
    );
  }

  // ===========================================
  // Transport
  // ===========================================

  /** Read `path`, describing failures in telemetry's own terms. */
  private async read<T>(path: string, signal?: AbortSignal): Promise<T> {
    try {
      return await this.transport.request<T>(path, signal ? { signal } : {});
    } catch (error) {
      if (!(error instanceof HttpRequestError)) throw error;
      if (error.status === 503)
        throw new HttpRequestError(
          503,
          "Telemetry storage isn’t responding. Try again in a moment.",
        );
      if (error.status === 400)
        throw new HttpRequestError(
          400,
          "These filters couldn’t be applied. Refresh the page and try again.",
        );
      throw error;
    }
  }
}

/** The query's set fields as a query string, or nothing. */
export function queryString(query: TelemetryQuery): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") parameters.set(key, String(value));
  const encoded = parameters.toString();
  return encoded ? `?${encoded}` : "";
}
