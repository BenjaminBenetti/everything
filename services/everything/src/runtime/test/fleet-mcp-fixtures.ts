import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { FleetMcpServer } from "../../fleet/interface/fleet-mcp-server.js";
import type { FleetMcpEndpoint } from "../../fleet/model/fleet-mcp-endpoint.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/** Fleet while it has not started: sessions open without its tools. */
export const stoppedFleet: FleetMcpServer = {
  endpoint: undefined,
  /** Fleet never starts in these tests. */
  whenRunning: () => new Promise(() => {}),
};

/** A tool call the fake server received. */
export interface ReceivedCall {
  readonly name: string;
  readonly arguments: unknown;
}

/** Extra tool definitions and responses for integration scenarios. */
interface FakeFleetOptions {
  readonly instanceTools?: boolean;
  readonly tools?: readonly Tool[];
  /** Return a scenario's MCP result for a recorded call. */
  readonly respond?: (call: ReceivedCall) => CallToolResult;
}

/** The JSON-RPC messages an MCP client sends. */
interface JsonRpcMessage {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: {
    readonly protocolVersion?: string;
    readonly name?: string;
    readonly arguments?: unknown;
  };
}

/** The request body as a JSON-RPC message. */
async function message(request: IncomingMessage): Promise<JsonRpcMessage> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * fleetd's MCP server as teammates see it: Streamable HTTP on loopback, behind a bearer token,
 * offering `fleet_list` and optional scenario tools. It records every JSON-RPC method it receives,
 * `DELETE` for a session the client ends, and every tool call.
 */
export async function startFakeFleetMcp(
  token: string,
  options: FakeFleetOptions = {},
) {
  const methods: string[] = [];
  const calls: ReceivedCall[] = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "DELETE") {
      methods.push("DELETE");
      response.writeHead(200).end();
      return;
    }
    // No server-initiated stream: clients fall back to request responses.
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const received = await message(request);
    methods.push(received.method);
    if (received.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    /** Answer the request with a JSON-RPC result. */
    const reply = (result: unknown) =>
      response
        .writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "fake-session",
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: received.id, result }));
    switch (received.method) {
      case "initialize":
        return reply({
          protocolVersion: received.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fleet", version: "test" },
        });
      case "tools/list":
        return reply({
          tools: [
            ...(options.instanceTools
              ? [
                  {
                    name: "fleet_exec",
                    description: "Run a command in one Fleet instance.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        fleet: { type: "string" },
                        instance: { type: "string" },
                        command: { type: "array", items: { type: "string" } },
                      },
                      required: ["fleet", "instance", "command"],
                    },
                  },
                ]
              : []),
            ...(options.tools ?? []),
            {
              name: "fleet_list",
              description: "List devcontainer instances across fleets.",
              inputSchema: {
                type: "object",
                properties: { fleet: { type: "string" } },
              },
            },
          ],
        });
      case "tools/call": {
        const call = {
          name: received.params?.name ?? "",
          arguments: received.params?.arguments,
        };
        calls.push(call);
        return reply(
          options.respond?.(call) ?? {
            content: [
              { type: "text", text: "FLEET_INSTANCES: web-01 running" },
            ],
          },
        );
      }
      default:
        return reply({});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint: FleetMcpEndpoint = {
    url: `http://127.0.0.1:${port}/`,
    token,
  };
  return {
    endpoint,
    methods,
    calls,
    /** Stop serving, dropping open connections. */
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
