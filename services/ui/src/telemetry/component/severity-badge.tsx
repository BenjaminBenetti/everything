import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { TelemetrySeverity } from "@everything/telemetry-contracts";
import { severityLabels } from "../model/telemetry-presentation.js";

/** Icons that distinguish severities without relying on color alone. */
const icons = {
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
} as const;

/** A record's severity as an icon and a word. */
export function SeverityBadge({ severity }: { severity: TelemetrySeverity }) {
  const Icon = icons[severity];
  return (
    <span className={`telemetry-severity ${severity}`}>
      <Icon aria-hidden="true" />
      {severityLabels[severity]}
    </span>
  );
}
