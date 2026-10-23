import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../../runtime/adapter/pi-session-factory.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { AgentRuntime } from "../../runtime/service/agent-runtime.js";
import { ReplyingAgentSession } from "../../runtime/service/replying-agent-session.js";
import { testApiDocumentation } from "../../runtime/test/api-documentation-fixtures.js";
import { testConversationSearch } from "../../runtime/test/conversation-search-fixtures.js";
import { stoppedFleet } from "../../runtime/test/fleet-mcp-fixtures.js";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";

/** One provider request the fake server received, and the attempt it was. */
export interface ProviderCall {
  readonly attempt: number;
  readonly signal: AbortSignal | undefined;
}

/** A Chat Completions stream: each event as an SSE data line, then the end marker unless `open`. */
export function sse(events: unknown[], open = false): Response {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  return new Response(lines.join("") + (open ? "" : "data: [DONE]\n\n"), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-request-id": "req_stream_ok",
    },
  });
}

/** A JSON error response with the given status, body, and headers. */
export function failure(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A teammate whose main conversation runs on a real Pi session through Everything's runtime, with
 * only the provider's HTTP transport replaced by `respond`.
 */
export async function teammate(
  context: TestContext,
  respond: (call: ProviderCall) => Promise<Response> | Response,
  ownerId = "owner-a",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "everything-telemetry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let attempt = 0;
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const inference = new PiInferenceRuntimeFactory(
    {
      /** The owner's saved connection to a compatible server. */
      async access() {
        return {
          baseUrl: "http://model.test/v1",
          credential: { apiKey: "sk-test-owner-key-0123456789" },
          model: "o3-mini",
        };
      },
    },
    {
      /** Model policy is covered by the provider tests. */
      async select(_ownerId, selection) {
        return { id: selection.model, name: selection.model };
      },
    },
    capabilities,
    async (_input, init) =>
      respond({ attempt: ++attempt, signal: init?.signal ?? undefined }),
  );
  const factory = new PiSessionFactory(
    inference,
    new FileSystemWorkspaces(directory),
    {} as ArtifactWorkbench,
    {} as WorkspaceTools,
    stoppedFleet,
    testApiDocumentation,
    testConversationSearch,
  );
  const definition: AgentDefinition = {
    id: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
    ownerId,
    name: "Kiwi helper",
    systemPrompt: "Help the user.",
    avatarId: "avatar-01",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
    createdAt: "",
  };
  const session = await factory.create(definition, async () => {});
  context.after(async () => {
    await session.abort();
    await session.dispose();
  });
  const runtime = new AgentRuntime(new ReplyingAgentSession(session, () => 0), {
    ownerId: definition.ownerId,
    agentId: definition.id,
  });
  return { runtime, definition, session };
}

/** Wait until the runtime's turn settles. */
export async function settled(runtime: AgentRuntime): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (runtime.status.status === "running") {
    if (Date.now() > deadline) throw new Error("The turn did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
