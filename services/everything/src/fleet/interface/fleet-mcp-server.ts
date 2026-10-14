import type { FleetMcpEndpoint } from "../model/fleet-mcp-endpoint.js";

/** fleetd's MCP server, which teammates reach once Fleet is running. */
export interface FleetMcpServer {
  /** The server's endpoint once Fleet is running, or undefined while it starts. */
  readonly endpoint: FleetMcpEndpoint | undefined;
  /** Resolve with the server's endpoint once Fleet is running. */
  whenRunning(): Promise<FleetMcpEndpoint>;
}
