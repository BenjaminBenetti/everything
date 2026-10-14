import type {
  ExtensionFactory,
  McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import type { FleetMcpServer } from "../../fleet/interface/fleet-mcp-server.js";
import type { FleetMcpEndpoint } from "../../fleet/model/fleet-mcp-endpoint.js";

/** The name sessions give fleetd's MCP server; Pi names its tools `mcp__fleet__<tool>`. */
const serverName = "fleet";

/** Fleet's lifecycle tools return a job to poll unless asked to wait, so only waits run this long. */
const requestTimeoutSeconds = 600;

/** Pi's name for one of Fleet's tools, such as `fleet_up`. */
export function fleetToolName(tool: string): string {
  return `mcp__${serverName}__${tool}`;
}

/** The tool allowlist entry that admits every Fleet tool. */
export const fleetToolPattern = fleetToolName("*");

/** Pi's tool that finds deferred tools, such as Fleet's, and declares the matches to the model. */
export const toolSearchToolName = "tool_search";

/**
 * Connect to fleetd's MCP server. Its tools stay out of every request until `tool_search` loads the
 * ones a teammate needs: declared up front, they would add about 21,000 characters to each request.
 */
function serverConfig(endpoint: FleetMcpEndpoint): McpServerConfig {
  return {
    url: endpoint.url,
    headers: { Authorization: `Bearer ${endpoint.token}` },
    exposure: "deferred",
    timeout: requestTimeoutSeconds,
    description:
      "Fleet: isolated development instances on the cluster, and the commands, tmux sessions, and coding agents that run in them.",
  };
}

/**
 * Give a teammate's session Fleet's tools. A session opened while Fleet is still starting receives
 * them once Fleet runs.
 */
export function fleetTools(fleet: FleetMcpServer): ExtensionFactory {
  return (pi) => {
    const endpoint = fleet.endpoint;
    if (endpoint) {
      pi.registerMcpServer(serverName, serverConfig(endpoint));
      return;
    }
    let open = true;
    pi.on("session_shutdown", () => {
      open = false;
    });
    void fleet.whenRunning().then((started) => {
      if (open) pi.registerMcpServer(serverName, serverConfig(started));
    });
  };
}
