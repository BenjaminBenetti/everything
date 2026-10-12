import { Check, Circle, LoaderCircle } from "lucide-react";
import type { ProviderConnection } from "@everything/provider-contracts";

/** Pair color with a readable label and icon so status never relies on color alone. */
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
        verified: "Verified",
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
