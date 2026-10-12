import { Check, Circle, LoaderCircle } from "lucide-react";
import type { ProviderConnection } from "@everything/provider-contracts";

/** Show the last connection result with a readable label and icon, including an explicit manual check in progress. */
export function ConnectionStatus({
  connection,
  pending = false,
}: {
  connection: ProviderConnection;
  pending?: boolean;
}) {
  const label = pending
    ? "Checking…"
    : {
        verified: "Connected",
        error: "Check failed",
        unverified: "Check needed",
        disconnected: "Not connected",
      }[connection.status];
  const Icon = pending
    ? LoaderCircle
    : connection.status === "verified"
      ? Check
      : Circle;
  return (
    <span
      className={
        "connection-status " + (pending ? "checking" : connection.status)
      }
      role="status"
    >
      <Icon aria-hidden="true" />
      {label}
    </span>
  );
}
