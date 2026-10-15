import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FleetMcpServer } from "../interface/fleet-mcp-server.js";
import type { FleetTools } from "../interface/fleet-tools.js";

/** Use Fleet's existing structured API without parsing terminal output. */
export class FleetMcpClient implements FleetTools {
  // ===========================================
  // Construction
  // ===========================================

  /** Receive endpoint discovery independently of daemon supervision. */
  constructor(private readonly fleet: FleetMcpServer) {}

  // ===========================================
  // Tool calls
  // ===========================================

  /** Bound each call and release its server session even when a tool fails. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const endpoint = this.fleet.endpoint;
    if (!endpoint) throw new Error("Fleet is not running");
    const client = new Client({
      name: "everything-workspaces",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${endpoint.token}` },
        redirect: "error",
      },
    });
    try {
      // The SDK's optional sessionId declaration predates exactOptionalPropertyTypes.
      await client.connect(transport as Transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 120_000 },
      );
      if (result.isError) throw new Error("Fleet tool failed");
      if (result.structuredContent !== undefined)
        return result.structuredContent;
      const content = result.content;
      if (Array.isArray(content)) {
        const text = content.find((item) => item.type === "text");
        if (text && typeof text.text === "string") return JSON.parse(text.text);
      }
      throw new Error("Fleet returned no structured result");
    } finally {
      const cleanup = setTimeout(() => void client.close(), 5_000);
      cleanup.unref();
      try {
        await transport.terminateSession().catch(() => undefined);
      } finally {
        clearTimeout(cleanup);
        await client.close();
      }
    }
  }
}
