import type { ProviderConnection } from "@everything/provider-contracts";

/** Explain the persisted check time and automatic schedule for a configured connection. */
export function ConnectionCheckDetails({
  connection,
}: {
  connection: Pick<ProviderConnection, "configured" | "lastCheckedAt">;
}) {
  if (!connection.configured) return null;
  return (
    <p className="connection-detail">
      {connection.lastCheckedAt && (
        <>
          Last checked{" "}
          <time dateTime={connection.lastCheckedAt}>
            {new Date(connection.lastCheckedAt).toLocaleString()}
          </time>
          .{" "}
        </>
      )}
      Checked automatically every 24 hours.
    </p>
  );
}
