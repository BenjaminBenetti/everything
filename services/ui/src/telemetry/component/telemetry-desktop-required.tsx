import { Monitor } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "../../workspace/component/empty-state.js";

/**
 * What a phone shows at the Telemetry address: a short explanation instead of the explorer, which
 * loads no telemetry. Recording continues whatever device is open.
 */
export function TelemetryDesktopRequired() {
  return (
    <div className="content-inner telemetry-desktop-required">
      <EmptyState icon={Monitor} title="Telemetry needs a larger screen">
        <p>
          Open Everything on a computer to search errors, requests, and teammate
          work. Everything keeps recording while you’re away.
        </p>
        <Link className="button light" to="/">
          Go to Home
        </Link>
      </EmptyState>
    </div>
  );
}
