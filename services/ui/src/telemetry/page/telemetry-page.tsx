import { TelemetryDesktopRequired } from "../component/telemetry-desktop-required.js";
import { TelemetryExplorer } from "../component/telemetry-explorer.js";
import { useDesktopLayout } from "../hook/use-desktop-layout.js";

/**
 * Telemetry is a desktop surface: the explorer on a desktop layout, and on a phone a short
 * explanation that loads nothing.
 */
export function TelemetryPage() {
  return useDesktopLayout() ? (
    <TelemetryExplorer />
  ) : (
    <TelemetryDesktopRequired />
  );
}
