/** fleetd's MCP server: a Streamable HTTP endpoint on loopback, and the bearer token it requires. */
export interface FleetMcpEndpoint {
  readonly url: string;
  readonly token: string;
}
