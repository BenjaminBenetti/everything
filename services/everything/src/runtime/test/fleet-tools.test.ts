import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import type { FleetMcpServer } from "../../fleet/interface/fleet-mcp-server.js";
import type { FleetMcpEndpoint } from "../../fleet/model/fleet-mcp-endpoint.js";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../adapter/pi-session-factory.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { fleetToolName, toolSearchToolName } from "../tool/fleet-tools.js";
import { startFakeFleetMcp } from "./fleet-mcp-fixtures.js";

/** What Pi sent to the model. */
interface CompletionRequest {
  tools?: { function: { name: string; description: string } }[];
  messages: { role: string; content?: unknown }[];
}

const fleetList = fleetToolName("fleet_list");

const teammate: AgentDefinition = {
  id: "teammate",
  ownerId: "owner",
  name: "Builder",
  systemPrompt: "Delegate coding work.",
  avatarId: "avatar-01",
  inference: {
    provider: "openai-compatible",
    model: "o3-mini",
    effort: "medium",
  },
  createdAt: "",
};

/** A Chat Completions SSE response that calls one tool. */
function toolCall(id: string, name: string, args: unknown): Response {
  return completion(
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}

/** One Chat Completions SSE response. */
function completion(delta: Record<string, unknown>, finish: string): Response {
  const event = {
    id: "completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "o3-mini",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", ...delta },
        finish_reason: finish,
      },
    ],
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Real Pi sessions whose model searches for Fleet's tools, lists Fleet's instances once `fleet_list`
 * is declared, and finishes once the result arrives.
 */
async function fixture(context: TestContext, fleet: FleetMcpServer) {
  const directory = await mkdtemp(path.join(tmpdir(), "everything-fleet-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const requests: CompletionRequest[] = [];
  const inference = new PiInferenceRuntimeFactory(
    {
      /** A connected provider for the teammate's owner. */
      async access() {
        return {
          credential: { apiKey: "model-key" },
          baseUrl: "http://models.test/v1",
          model: "o3-mini",
        };
      },
    },
    {
      /** The saved model is available. */
      async select(_ownerId, selection) {
        return { id: selection.model, name: selection.model };
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as CompletionRequest;
      requests.push(body);
      const offered = offeredTools(body);
      const last = body.messages.at(-1);
      const id = `call-${requests.length}`;
      if (JSON.stringify(last).includes("FLEET_INSTANCES"))
        return completion({ content: "Done." }, "stop");
      if (offered.includes(fleetList)) return toolCall(id, fleetList, {});
      if (offered.includes(toolSearchToolName) && last?.role !== "tool")
        return toolCall(id, toolSearchToolName, {
          query: "fleet list instances",
        });
      return completion({ content: "Done." }, "stop");
    },
  );
  const factory = new PiSessionFactory(
    inference,
    new FileSystemWorkspaces(directory),
    {} as ArtifactWorkbench,
    {} as WorkspaceTools,
    fleet,
  );
  return { directory, factory, requests };
}

/** The names of the tools a request offered the model. */
function offeredTools(request: CompletionRequest | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.function.name);
}

test("teammates get Fleet's tools, call them through fleetd's MCP server with its token, and end the MCP session when closed", async (context) => {
  const server = await startFakeFleetMcp("fleet-secret-token");
  context.after(() => server.close());
  const { directory, factory, requests } = await fixture(context, {
    endpoint: server.endpoint,
    whenRunning: async () => server.endpoint,
  });
  const session = await factory.create(teammate, async () => {});
  context.after(() => session.dispose());
  await session.prompt("Which instances are running?");
  assert.ok(offeredTools(requests[0]).includes(toolSearchToolName));
  assert.ok(
    !offeredTools(requests[0]).includes(fleetList),
    "Fleet's tools stay out of requests until a search loads them",
  );
  assert.match(
    JSON.stringify(requests[0]!.messages[0]),
    /Fleet: isolated development instances on the cluster/,
  );
  assert.match(
    requests[1]!.tools!.find((tool) => tool.function.name === fleetList)!
      .function.description,
    /List devcontainer instances/,
  );
  assert.deepEqual(server.calls, [{ name: "fleet_list", arguments: {} }]);
  assert.match(
    JSON.stringify(requests[2]?.messages.at(-1)),
    /FLEET_INSTANCES: web-01 running/,
  );
  assert.ok(
    !JSON.stringify(requests).includes("fleet-secret-token"),
    "fleetd's token never reaches the model",
  );
  await session.dispose();
  assert.ok(server.methods.includes("DELETE"), "closing ends the MCP session");
  const sessions = path.join(directory, teammate.id, ".pi", "sessions");
  for (const filename of await readdir(sessions))
    assert.ok(
      !(await readFile(path.join(sessions, filename), "utf8")).includes(
        "fleet-secret-token",
      ),
    );
});

test("a teammate opened while Fleet starts receives Fleet's tools once it runs", async (context) => {
  const server = await startFakeFleetMcp("fleet-secret-token");
  context.after(() => server.close());
  let run!: (endpoint: FleetMcpEndpoint) => void;
  const running = new Promise<FleetMcpEndpoint>((resolve) => (run = resolve));
  const { factory, requests } = await fixture(context, {
    endpoint: undefined,
    whenRunning: () => running,
  });
  const session = await factory.create(teammate, async () => {});
  context.after(() => session.dispose());
  await session.prompt("Before Fleet runs");
  assert.ok(!offeredTools(requests[0]).includes(fleetList));
  run(server.endpoint);
  const deadline = Date.now() + 5_000;
  while (!server.methods.includes("tools/list") && Date.now() < deadline)
    await sleep(20);
  await session.prompt("After Fleet runs");
  assert.deepEqual(server.calls, [{ name: "fleet_list", arguments: {} }]);
});
