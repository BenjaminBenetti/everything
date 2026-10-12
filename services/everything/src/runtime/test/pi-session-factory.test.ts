import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../../agent/model/agent.js";
import type { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { PiSessionFactory } from "../adapter/pi-session-factory.js";
import type { InferenceRuntimeFactory } from "../interface/inference-runtime.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { ProviderInactiveError } from "../../provider/error/provider-errors.js";
import { mainAgentPrompt } from "../prompt/main-agent-prompt.js";

const agent: AgentDefinition = {
  id: "agent-id",
  ownerId: "owner",
  name: "Chosen",
  systemPrompt: "Help",
  avatarId: "avatar-01",
  inference: null,
  createdAt: "",
};

/** A model runtime with no connected provider. */
const disconnectedModels: InferenceRuntimeFactory = {
  /** An unassigned teammate must never resolve a default provider. */
  async create() {
    throw new Error("Unexpected inference creation");
  },
};

test("refuses to open a session until a provider is connected, before touching the agent's files", async (context) => {
  const agentsDirectory = await mkdtemp(
    path.join(tmpdir(), "everything-agents-"),
  );
  context.after(() => rm(agentsDirectory, { recursive: true, force: true }));
  const factory = new PiSessionFactory(
    disconnectedModels,
    new FileSystemWorkspaces(agentsDirectory),
    {} as ArtifactWorkbench,
  );
  await assert.rejects(
    factory.create(agent, async () => {}),
    { code: "PROVIDER_UNAVAILABLE" },
  );
  assert.equal(existsSync(path.join(agentsDirectory, agent.id)), false);
});

/** Return a minimal completed chat-completions stream through the real Pi adapter. */
function completedStream(): Response {
  return new Response(
    [
      {
        id: "completion",
        object: "chat.completion.chunk",
        created: 1,
        model: "o3-mini",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Done" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "completion",
        object: "chat.completion.chunk",
        created: 1,
        model: "o3-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Pi sends only the teammate's initial context, applies saved inference, and reopens the same history after edits", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "everything-inference-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, agent.id);
  const privateDirectory = path.join(workspace, ".pi");
  await mkdir(privateDirectory, { recursive: true });
  for (const filename of [
    path.join(directory, "AGENTS.md"),
    path.join(workspace, "AGENTS.md"),
    path.join(privateDirectory, "SYSTEM.md"),
    path.join(privateDirectory, "APPEND_SYSTEM.md"),
  ])
    await writeFile(filename, "UNRELATED_HOST_CONTEXT: Never use this prompt.");
  let connected = true;
  let apiKey = "first-owner-key";
  const requests: {
    body: Record<string, unknown>;
    authorization: string | null;
  }[] = [];
  const inference = new PiInferenceRuntimeFactory(
    {
      /** Every inference request must recheck this exact owner and provider. */
      async access(ownerId, provider) {
        assert.equal(ownerId, "owner");
        assert.equal(provider, "openai-compatible");
        if (!connected) throw new ProviderInactiveError();
        return {
          credential: { apiKey },
          baseUrl: "http://models.test/v1",
          model: "o3-mini",
        };
      },
    },
    {
      /** Selection policy is covered separately; this test exercises real Pi execution. */
      async validate() {},
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (input, init) => {
      assert.equal(String(input), "http://models.test/v1/chat/completions");
      assert.equal(init?.redirect, "error");
      requests.push({
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return completedStream();
    },
  );
  const factory = new PiSessionFactory(
    inference,
    new FileSystemWorkspaces(directory),
    {} as ArtifactWorkbench,
  );
  const definition: AgentDefinition = {
    ...agent,
    systemPrompt:
      "SAVED_TEAMMATE_INSTRUCTIONS: Help plan small gardening projects.",
    inference: {
      provider: "openai-compatible",
      model: "o3-mini",
      effort: "high",
    },
  };
  const session = await factory.create(definition, async () => {});
  context.after(() => session.dispose());
  await session.prompt("First message");
  assert.equal(requests[0]?.body.model, "o3-mini");
  assert.equal(requests[0]?.body.reasoning_effort, "high");
  assert.equal(requests[0]?.authorization, "Bearer first-owner-key");
  const initialMessages = requests[0]!.body.messages as {
    role: string;
    content: unknown;
  }[];
  assert.equal(
    initialMessages.length,
    2,
    "a new teammate has no seeded history",
  );
  assert.ok(["system", "developer"].includes(initialMessages[0]!.role));
  assert.equal(
    initialMessages[0]!.content,
    `${mainAgentPrompt(definition)}\n\n<cwd>\n${workspace}\n</cwd>`,
    "the provider receives saved instructions, harness rules, and the teammate's workspace path",
  );
  assert.equal(initialMessages[1]!.role, "user");
  assert.ok(
    JSON.stringify(initialMessages[1]!.content).includes("First message"),
  );
  assert.ok(
    !JSON.stringify(requests[0]!.body).includes("UNRELATED_HOST_CONTEXT"),
  );
  assert.ok(!JSON.stringify(requests[0]!.body).includes("first-owner-key"));
  apiKey = "";
  await session.prompt("Second message");
  assert.equal(requests[1]?.authorization, null);
  session.dispose();
  const edited = await factory.create(
    {
      ...definition,
      name: "Updated teammate",
      systemPrompt:
        "UPDATED_TEAMMATE_INSTRUCTIONS: Keep gardening advice brief.",
      inference: { ...definition.inference!, model: "o4-mini", effort: "low" },
    },
    async () => {},
  );
  context.after(() => edited.dispose());
  assert.equal(edited.id, session.id);
  await edited.prompt("After editing");
  assert.equal(requests[2]?.body.reasoning_effort, "low");
  assert.equal(requests[2]?.body.model, "o4-mini");
  assert.ok(
    JSON.stringify(requests[2]?.body.messages).includes("First message"),
  );
  const updatedMessages = requests[2]!.body.messages as {
    role: string;
    content: string;
  }[];
  const updatedPrompt = updatedMessages
    .filter((message) => ["system", "developer"].includes(message.role))
    .at(-1)!.content;
  assert.ok(updatedPrompt.includes("UPDATED_TEAMMATE_INSTRUCTIONS"));
  assert.ok(updatedPrompt.includes("named Updated teammate"));
  connected = false;
  await assert.rejects(
    edited.prompt("Disconnected"),
    /Pi model request failed/,
  );
  assert.equal(requests.length, 3);
  const sessionDirectory = path.join(directory, agent.id, ".pi", "sessions");
  for (const filename of await readdir(sessionDirectory)) {
    const stored = await readFile(
      path.join(sessionDirectory, filename),
      "utf8",
    );
    assert.ok(!stored.includes("first-owner-key"));
  }
  assert.equal(
    existsSync(path.join(directory, agent.id, ".pi", "auth.json")),
    false,
  );
});
