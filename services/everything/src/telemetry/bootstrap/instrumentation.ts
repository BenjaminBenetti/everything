import { loadTelemetrySettingsOrUnavailable } from "../config/telemetry-config.js";
import { startTelemetry } from "../factory/telemetry-runtime.js";

/**
 * Preloaded with `node --import` before the application, so the libraries it instruments, such as
 * Node's HTTP server and the PostgreSQL client, are patched before they load. Telemetry never stops
 * Everything from starting: any failure here leaves it off, with one line on standard error.
 */
try {
  startTelemetry(loadTelemetrySettingsOrUnavailable(process.env));
} catch {
  console.warn("Telemetry could not start; Everything continues without it.");
}
