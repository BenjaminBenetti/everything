import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultAgentAvatarId } from "@everything/agent-contracts/avatar";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { HttpModelDiscovery } from "../../provider/adapter/http-model-discovery.js";
import { ProviderModelService } from "../../provider/service/provider-models.js";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { agentController } from "../controller/agent-controller.js";
import { agentEditingController } from "../controller/agent-editing-controller.js";
import type { AgentProfileStore } from "../interface/agent-profile-store.js";
import type { AgentRepository } from "../interface/agent-repository.js";
import type { AgentDefinition } from "../model/agent.js";
import { AgentEditingService } from "../service/agent-editing-service.js";
import { AgentService } from "../service/agent-service.js";

test("a saved Default effort that a model's new effort list excludes is refused unchanged until its owner chooses a listed effort", async (context) => {
  const id = "3d9a6c2e-5b1f-4e7a-8c0d-1f2e3a4b5c6d";
  let saved: AgentDefinition | undefined;
  /** The stored selection, read as the repository holds it. */
  const stored = () => saved?.inference;
  const repository: AgentRepository & AgentProfileStore = {
    /** Use explicit ownership on every read and write. */
    async list({ ownerId }) {
      return saved?.ownerId === ownerId ? [saved] : [];
    },
    /** Store selections exactly as validated, as the JSON column does. */
    async create({ ownerId }, input) {
      return (saved = structuredClone({
        ...input,
        id,
        ownerId,
        createdAt: "2026-01-01",
        avatarId: input.avatarId ?? defaultAgentAvatarId,
        inference: input.inference ?? null,
      }));
    },
    /** Missing and foreign definitions are indistinguishable. */
    async getById({ ownerId }, target) {
      return saved?.ownerId === ownerId && saved.id === target
        ? structuredClone(saved)
        : undefined;
    },
    /** Apply the full selection in one persistence operation. */
    async update(scope, target, changes) {
      if (!(await this.getById(scope, target))) return undefined;
      return (saved = structuredClone({ ...saved!, ...changes }));
    },
    /** Delete only an owned definition. */
    async delete(scope, target) {
      if (await this.getById(scope, target)) saved = undefined;
    },
  };
  // The account catalog first lists the model without effort levels, then with low and high.
  let listed: Record<string, unknown> = {
    slug: "gpt-6.1-terra",
    display_name: "GPT-6.1 Terra",
    visibility: "list",
  };
  const responses: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer oauth-owner",
    );
    if (url === "https://api.openai.com/v1/models")
      return Response.json({ models: [listed] });
    assert.equal(url, "https://api.openai.com/v1/responses");
    responses.push(JSON.parse(String(init?.body)));
    return new Response(
      [
        { type: "response.created", response: { id: "response" } },
        {
          type: "response.completed",
          response: { id: "response", status: "completed", output: [] },
        },
      ]
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const access = {
    /** One owner's ChatGPT sign-in, with a fake token. */
    async access(ownerId: string) {
      assert.equal(ownerId, "owner");
      return {
        credential: { accessToken: "oauth-owner" },
        baseUrl: null,
        model: null,
      };
    },
  };
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const models = new ProviderModelService(
    access,
    new HttpModelDiscovery(fetcher),
    capabilities,
  );
  const runtimes = new PiInferenceRuntimeFactory(
    access,
    models,
    capabilities,
    fetcher,
  );
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const agents = new AgentService(repository, models);
  await agentController(app, agents, agents);
  await agentEditingController(
    app,
    new AgentEditingService(repository, models),
  );

  // A model missing from Pi's catalog, with no listed levels, offers only Default.
  const [unknown] = await models.list("owner", "chatgpt");
  assert.deepEqual(
    [unknown!.effortSource, unknown!.efforts],
    ["unknown", ["off"]],
  );
  const defaultEffort = {
    provider: "chatgpt",
    model: "gpt-6.1-terra",
    effort: "off",
  } as const;
  const created = await app.inject({
    method: "POST",
    url: "/agents",
    payload: { name: "Terra", systemPrompt: "Help", inference: defaultEffort },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().inference, defaultEffort);
  assert.deepEqual(stored(), defaultEffort);

  // The account catalog now lists low and high, without none.
  listed = {
    ...listed,
    supported_reasoning_levels: [
      { effort: "low", description: "Low" },
      { effort: "high", description: "High" },
    ],
  };
  const [described] = await models.list("owner", "chatgpt");
  assert.deepEqual(
    [described!.effortSource, described!.efforts, described!.defaultEffort],
    ["provider", ["low", "high"], "low"],
  );
  await assert.rejects(runtimes.create("owner", stored()!), {
    code: "INFERENCE_SELECTION_INVALID",
  });
  assert.equal(responses.length, 0);
  // Saving Default again is refused too, and the saved choice is never replaced for the owner.
  const resaved = await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { inference: defaultEffort },
  });
  assert.equal(resaved.statusCode, 400);
  assert.equal(resaved.json().code, "INFERENCE_SELECTION_INVALID");
  assert.deepEqual(
    (await app.inject(`/agents/${id}`)).json().inference,
    defaultEffort,
  );

  // The owner chooses a listed effort, which saves and reaches the provider as its own value.
  const chosen = { ...defaultEffort, effort: "high" } as const;
  const repaired = await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { inference: chosen },
  });
  assert.equal(repaired.statusCode, 200);
  assert.deepEqual(repaired.json().inference, chosen);
  assert.deepEqual(stored(), chosen);
  const runtime = await runtimes.create("owner", stored()!);
  await runtime.models.completeSimple(
    runtime.model,
    { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
    { reasoning: stored()!.effort as "high" },
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.model, "gpt-6.1-terra");
  assert.deepEqual(
    (responses[0]!.reasoning as { effort: string }).effort,
    "high",
  );
});
