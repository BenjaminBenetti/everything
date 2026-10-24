import { OpenObserveSearch } from "../adapter/openobserve-search.js";
import type { TelemetryReader } from "../interface/telemetry-reader.js";
import type { TelemetrySettings } from "../model/telemetry-settings.js";
import { TelemetryQueryService } from "../service/telemetry-query-service.js";
import { activeTelemetry } from "./telemetry-runtime.js";

/**
 * The API's telemetry reader: OpenObserve when telemetry is configured with readable credentials,
 * otherwise a reader that reports telemetry as off or unavailable. Export health comes from the
 * runtime the instrumentation preload started, if any.
 */
export function createTelemetryReader(
  settings: TelemetrySettings,
): TelemetryReader {
  return new TelemetryQueryService(
    settings,
    settings.backend
      ? {
          search: new OpenObserveSearch(settings.backend),
          stream: settings.backend.stream,
        }
      : null,
    () => activeTelemetry()?.health() ?? null,
  );
}
