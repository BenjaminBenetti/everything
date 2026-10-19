/** The group of fleetd's settings that holds its gateway registration and remote toggles. */
const remoteSettingsKey = "remote_mcp_settings";

/**
 * fleetd's settings with remote control through `gatewayUrl` turned on. Only the gateway address,
 * the Remote Fleet toggle, and its transport are Everything's; every other setting is kept,
 * including whether Remote MCP, webhooks, and the image registry are on.
 */
export function withGatewayRemote(
  config: Readonly<Record<string, unknown>>,
  gatewayUrl: string,
): Record<string, unknown> {
  const current = config[remoteSettingsKey];
  const remote =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? current
      : {};
  return {
    ...config,
    [remoteSettingsKey]: {
      ...remote,
      gateway_url: gatewayUrl,
      fleet_enabled: true,
      fleet_mode: "gateway",
    },
  };
}

/** A gateway session id, 256 bits in hex, as the gateway mints them. */
const sessionId = /^[0-9a-f]{64}$/;

/**
 * The `FLEET_GATEWAY` address remote clients dial, from fleetd's gateway session file: the Public GRPC
 * URL the gateway gave the session it registered for `gatewayUrl`. The gateway serves clients where
 * fleetd registers, so anything else, such as a session left from another gateway, is ignored.
 */
export function publishedGatewayAddress(
  session: unknown,
  gatewayUrl: string,
): string | undefined {
  if (typeof session !== "object" || session === null) return undefined;
  const { gateway_url: registeredWith, public_grpc_url: address } =
    session as Record<string, unknown>;
  if (registeredWith !== gatewayUrl || typeof address !== "string")
    return undefined;
  const prefix = `${gatewayUrl}/grpc/`;
  return address.startsWith(prefix) &&
    sessionId.test(address.slice(prefix.length))
    ? address
    : undefined;
}
