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
import type { WorkspaceActivityRecorder } from "../../workspace/interface/workspace-activity.js";

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
async function fixture(
  context: TestContext,
  fleet: FleetMcpServer,
  options?: {
    activity?: WorkspaceActivityRecorder;
    respond?: (request: CompletionRequest) => Response;
  },
) {
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
      if (options?.respond) return options.respond(body);
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
    options?.activity,
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

test("real Fleet calls from main, child, and nested forks retain the root teammate identity while another chat stays separate", async (context) => {
  const server = await startFakeFleetMcp("fleet-secret-token", true);
  context.after(() => server.close());
  const interactions: { agentId: string; ownerId: string; name: string }[] = [];
  const steps = new Map<string, number>();
  const exec = fleetToolName("fleet_exec");
  const { factory } = await fixture(
    context,
    { endpoint: server.endpoint, whenRunning: async () => server.endpoint },
    {
      activity: {
        /** Record the immutable session binding separately from any Fleet input. */
        async touch(scope, workspace) {
          interactions.push({ ...scope, name: workspace.name });
        },
      },
      /** Script actual Pi tool discovery, execution, and fork creation without external inference. */
      respond(request) {
        const system = String(request.messages[0]!.content);
        const fork = system.match(
          /You are private fork ([^,]+), started by ([^.\n]+)/,
        );
        const kind = system.includes("/other-chat")
          ? "other"
          : fork
            ? fork[2] === "main"
              ? "child"
              : "nested"
            : "main";
        const id = fork?.[1] ?? kind;
        const index = steps.get(id) ?? 0;
        if (!offeredTools(request).includes(exec))
          return toolCall(`${id}-search`, toolSearchToolName, {
            query: "fleet exec command",
          });
        steps.set(id, index + 1);
        if (index === 0)
          return toolCall(`${id}-exec`, exec, {
            fleet: "web",
            instance: "shared-preview",
            command: ["echo", kind],
          });
        if (index === 1 && ["main", "child"].includes(kind))
          return toolCall(`${id}-fork`, "fork", {
            task: "Use the shared preview workspace.",
          });
        return completion({ content: "Finished the workspace check." }, "stop");
      },
    },
  );
  const main = await factory.create(teammate, async () => {});
  context.after(() => main.dispose());
  await main.prompt("Use workspaces in the main session and private forks.");
  const deadline = Date.now() + 10_000;
  while (
    (interactions.length < 6 || main.background?.running) &&
    Date.now() < deadline
  )
    await sleep(20);
  assert.equal(main.background?.running, false);
  assert.deepEqual(
    interactions,
    Array.from({ length: 6 }, () => ({
      agentId: "teammate",
      ownerId: "owner",
      name: "shared-preview",
    })),
  );
  assert.deepEqual(
    server.calls
      .filter((call) => call.name === "fleet_exec")
      .map((call) => (call.arguments as { command: string[] }).command[1]),
    ["main", "child", "nested"],
  );
  const other = await factory.create(
    { ...teammate, id: "other-chat" },
    async () => {},
  );
  context.after(() => other.dispose());
  await other.prompt("Use the same workspace from a different chat.");
  assert.deepEqual(
    interactions.slice(6),
    Array.from({ length: 2 }, () => ({
      agentId: "other-chat",
      ownerId: "owner",
      name: "shared-preview",
    })),
  );
});
