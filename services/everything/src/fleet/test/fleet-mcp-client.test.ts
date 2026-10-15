import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FleetMcpClient } from "../adapter/fleet-mcp-client.js";

test("reads Fleet's streamed structured results and closes sessions after successes and tool failures", async (context) => {
  const calls: unknown[] = [];
  let terminations = 0;
  let fail = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (request.method === "DELETE") {
      terminations++;
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fleet", version: "fixture" },
          }
        : fail
          ? {
              isError: true,
              content: [{ type: "text", text: "internal runtime failure" }],
            }
          : {
              structuredContent: { instances: [] },
              content: [{ type: "text", text: '{"instances":[]}' }],
            };
    if (message.method === "tools/call") calls.push(message.params);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "mcp-session-id": "fixture-session",
    });
    response.end(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const endpoint = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: "fixture-token",
  };
  const client = new FleetMcpClient({
    endpoint,
    /** The fixture is already running. */ async whenRunning() {
      return endpoint;
    },
  });
  assert.deepEqual(await client.call("fleet_list", { fleet: "web" }), {
    instances: [],
  });
  fail = true;
  await assert.rejects(
    client.call("fleet_stop", { fleet: "web", instance: "dev-1" }),
    /Fleet tool failed/,
  );
  assert.equal(terminations, 2);
  assert.deepEqual(calls, [
    { name: "fleet_list", arguments: { fleet: "web" } },
    { name: "fleet_stop", arguments: { fleet: "web", instance: "dev-1" } },
  ]);
});
