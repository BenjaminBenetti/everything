import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import type { ProviderId } from "@everything/provider-contracts";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import type { AgentDefinition } from "../../agent/model/agent.js";
import { ArtifactRequestFailure } from "../../artifact/error/artifact-errors.js";
import type {
  ArtifactGateway,
  SourceChoice,
} from "../../artifact/interface/artifact-gateway.js";
import { ArtifactWorkbench } from "../../artifact/service/artifact-workbench.js";
import { noCredentialGrants } from "../../credential/test/credential-fixture.js";
import type { WorkspaceTools } from "../../workspace/interface/workspace-tools.js";
import { FileSystemWorkspaces } from "../../workspace/service/file-system-workspaces.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { PiSessionFactory } from "../adapter/pi-session-factory.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { appTools } from "../tool/app-tools.js";
import { testApiDocumentation } from "./api-documentation-fixtures.js";
import { testConversationSearch } from "./conversation-search-fixtures.js";
import { stoppedFleet } from "./fleet-mcp-fixtures.js";

/** Model usage every fixture Responses stream reports. */
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  total_tokens: 2,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};

/** Encode provider events as a server-sent event response for the native SDKs. */
function stream(events: { type: string; [key: string]: unknown }[]): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A completed Responses stream that calls `name` with `json` when given, or says nothing. */
function responses(call?: { name: string; json: string }): Response {
  const item = call && {
    type: "function_call",
    id: "function_0",
    call_id: "call_0",
    name: call.name,
  };
  return stream([
    { type: "response.created", response: { id: "response" } },
    ...(item && call
      ? [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: call.json,
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { ...item, arguments: call.json, status: "completed" },
          },
        ]
      : []),
    {
      type: "response.completed",
      response: { id: "response", status: "completed", output: [], usage },
    },
  ]);
}

/** A completed Messages stream with no reply. */
function messages(model: string): Response {
  return stream([
    {
      type: "message_start",
      message: {
        id: "message",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

/** A completed chat-completions stream that says "Done". */
function completions(): Response {
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

/** A tool definition as one provider request serialized it. */
type SentTool = Record<string, unknown> & {
  readonly name?: string;
  readonly function?: Record<string, unknown> & { readonly name: string };
};

/**
 * A teammate on `selection` whose provider answers each request through `respond`, opened by the
 * production session factory with every tool it registers. Requests' JSON bodies are recorded.
 */
async function teammate(
  context: TestContext,
  selection: InferenceSelection,
  respond: (number: number) => Response,
  artifacts = {} as ArtifactWorkbench,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "everything-tools-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bodies: Record<string, unknown>[] = [];
  const inference = new PiInferenceRuntimeFactory(
    {
      /** Give each provider the credential shape its real connection stores. */
      async access(_ownerId, provider: ProviderId) {
        return provider === "chatgpt"
          ? {
              credential: { accessToken: "oauth-owner" },
              baseUrl: null,
              model: null,
            }
          : provider === "anthropic"
            ? {
                credential: { apiKey: "claude-key" },
                baseUrl: "https://api.anthropic.com/v1",
                model: null,
              }
            : {
                credential: { apiKey: "local-key" },
                baseUrl: "http://models.test/v1",
                model: "o3-mini",
              };
      },
    },
    {
      /** Model policy is covered by the provider tests; this account lists every paid speed. */
      async select(_ownerId, choice) {
        return {
          id: choice.model,
          name: choice.model,
          speeds: { offered: ["fast", "ultrafast"], complete: true },
        };
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return respond(bodies.length);
    },
  );
  const factory = new PiSessionFactory(
    inference,
    new FileSystemWorkspaces(directory),
    artifacts,
    {} as WorkspaceTools,
    stoppedFleet,
    testApiDocumentation,
    testConversationSearch,
  );
  const agent: AgentDefinition = {
    id: "agent-id",
    ownerId: "owner",
    name: "Ada",
    systemPrompt: "Help",
    avatarId: "avatar-01",
    inference: selection,
    createdAt: "",
  };
  const session = await factory.create(agent, async () => {});
  context.after(() => session.dispose());
  return { session, bodies, workspace: path.join(directory, agent.id) };
}

/** The tools one request sent. */
const sentTools = (body: Record<string, unknown> | undefined) =>
  (body?.tools ?? []) as SentTool[];

/** checkout_app's parameters exactly as its definition declares them, serialized as JSON. */
function declaredCheckout() {
  const tool = appTools({} as ArtifactWorkbench, {
    ownerId: "owner",
    author: { id: "agent-id", name: "Ada" },
    workspace: "/workspace",
    shared: "/shared",
    privateDirectory: "/workspace/.pi",
  }).find((candidate) => candidate.name === "checkout_app")!;
  return JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
}

// ===========================================
// ChatGPT sign-in: OpenAI Responses
// ===========================================

test("ChatGPT tools say strict: false and keep their declared required fields, whether or not Pi's catalog knows the model, at every speed", async (context) => {
  const declared = declaredCheckout();
  assert.deepEqual(declared.required, ["app", "directory"]);
  // Responses treats a tool sent without `strict` as strict when it can, which makes every field
  // required: https://developers.openai.com/api/docs/guides/function-calling#strict-mode
  let reference: SentTool[] | undefined;
  for (const model of [
    "gpt-6.1-sol",
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6.1-terra",
  ])
    for (const [speed, tier] of [
      ["standard", undefined],
      ["fast", "priority"],
      ["ultrafast", "ultrafast"],
    ] as const) {
      const { session, bodies } = await teammate(
        context,
        { provider: "chatgpt", model, effort: "high", speed },
        () => responses(),
      );
      await session.prompt("Hello");
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]!.model, model);
      assert.equal(bodies[0]!.service_tier, tier);
      const tools = sentTools(bodies[0]);
      assert.ok(tools.length > 0);
      for (const tool of tools)
        assert.equal(tool.strict, false, `${model} ${speed} ${tool.name}`);
      const checkout = tools.find((tool) => tool.name === "checkout_app");
      assert.deepEqual(checkout?.parameters, declared, `${model} ${speed}`);
      // Every model and speed is sent the very same tools.
      reference ??= tools;
      assert.deepEqual(tools, reference, `${model} ${speed}`);
    }
});

test("a checkout_app call naming a revision and a build reaches the apps service as sent, whose refusal returns to the model before anything is written", async (context) => {
  const content = "FROM scratch\n";
  const choices: SourceChoice[] = [];
  const gateway = {
    /** Answer as the apps service does: one selector at most, and the live build by default. */
    async source(_ownerId: string, _reference: string, choice: SourceChoice) {
      choices.push(choice);
      if (Object.keys(choice).length > 1)
        throw new ArtifactRequestFailure(
          400,
          "INVALID_REQUEST",
          "The request does not match the API schema.",
        );
      return {
        origin: "build",
        number: choice.build ?? 1,
        release: 1,
        files: [
          {
            path: "Dockerfile",
            sha256: createHash("sha256").update(content).digest("hex"),
            size: content.length,
            executable: false,
          },
        ],
      };
    },
    async readContent() {
      return Readable.from([content]);
    },
  } as unknown as ArtifactGateway;
  const workbench = new ArtifactWorkbench(gateway, noCredentialGrants);
  for (const [directory, input, written] of [
    ["both", { revision: 1, build: 1 }, false],
    ["unused", { revision: null, build: null, overwrite: null }, true],
    ["live", {}, true],
  ] as const) {
    const { session, bodies, workspace } = await teammate(
      context,
      { provider: "chatgpt", model: "gpt-6.2-sol", effort: "high" },
      (number) =>
        number === 1
          ? responses({
              name: "checkout_app",
              json: JSON.stringify({ app: "game", directory, ...input }),
            })
          : responses(),
      workbench,
    );
    await session.prompt("Check out the game");
    assert.equal(bodies.length, 2);
    const output = (bodies[1]!.input as Record<string, unknown>[]).find(
      (item) => item.type === "function_call_output",
    );
    const target = path.join(workspace, directory);
    if (written) {
      assert.match(String(output?.output), /"origin": "build"/);
      assert.equal(
        await readFile(path.join(target, "Dockerfile"), "utf8"),
        content,
      );
    } else {
      assert.match(
        String(output?.output),
        /The request does not match the API schema/,
      );
      assert.equal(existsSync(target), false, "nothing was written");
    }
  }
  // Both selectors are forwarded as the model sent them; unused nulls are dropped as omitted.
  assert.deepEqual(choices, [{ revision: 1, build: 1 }, {}, {}]);
});

// ===========================================
// Other providers
// ===========================================

test("Claude and OpenAI-compatible requests send the same declared tools, with no strict field", async (context) => {
  const declared = declaredCheckout();
  for (const [selection, respond] of [
    [
      { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
      () => messages("claude-opus-5-5"),
    ],
    [
      { provider: "openai-compatible", model: "o3-mini", effort: "high" },
      completions,
    ],
  ] as const) {
    const { session, bodies } = await teammate(context, selection, respond);
    await session.prompt("Hello");
    const tools = sentTools(bodies[0]);
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.ok(!("strict" in tool), `${selection.provider} ${tool.name}`);
      assert.ok(!("strict" in (tool.function ?? {})), selection.provider);
    }
    const checkout = tools.find(
      (tool) => (tool.name ?? tool.function?.name) === "checkout_app",
    );
    // Pi's Messages adapter sends a schema's properties and required list only.
    const { properties, required } = (checkout?.input_schema ??
      checkout?.function?.parameters) as Record<string, unknown>;
    assert.deepEqual(
      { properties, required },
      { properties: declared.properties, required: declared.required },
      selection.provider,
    );
  }
});
