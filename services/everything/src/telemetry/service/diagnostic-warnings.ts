import {
  telemetryAttributes as attribute,
  telemetryEvents,
} from "../model/telemetry-attributes.js";
import { recordTelemetryEvent } from "./telemetry-recorder.js";

/** Identifiers and short reasons a warning may carry, never request or record contents. */
export type WarningDetails = Readonly<Record<string, string | undefined>>;

/** Detail names recorded as event attributes; others stay in the process log only. */
const recordedDetails: Readonly<Record<string, string>> = {
  agentId: attribute.agentId,
  code: attribute.code,
  reason: attribute.reason,
};

/**
 * Record an installation-level warning, such as a background service retrying, as a telemetry
 * event. These warnings belong to no owner, so they appear on nobody's Telemetry page; operators
 * can find them in OpenObserve. Text is redacted before export.
 */
export function recordWarning(
  message: string,
  details: WarningDetails = {},
): void {
  recordTelemetryEvent({
    name: telemetryEvents.warning,
    title: message,
    type: "log",
    severity: "warning",
    attributes: Object.fromEntries(
      Object.entries(details)
        .filter(([name, value]) => recordedDetails[name] && value !== undefined)
        .map(([name, value]) => [recordedDetails[name]!, value!]),
    ),
  });
}

/** Write a warning to standard error, exactly as before, and record it as a telemetry event. */
export function reportWarning(message: string, details?: WarningDetails): void {
  if (details) console.warn(message, details);
  else console.warn(message);
  recordWarning(message, details);
}
