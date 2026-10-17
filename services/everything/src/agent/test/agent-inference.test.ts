import assert from "node:assert/strict";
import { test } from "node:test";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import { defaultAgentAvatarId } from "@everything/agent-contracts/avatar";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import {
  ProviderInactiveError,
  InferenceSelectionError,
} from "../../provider/error/provider-errors.js";
import { ProviderModelService } from "../../provider/service/provider-models.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import { AgentService } from "../service/agent-service.js";
import { AgentEditingService } from "../service/agent-editing-service.js";
import { agentController } from "../controller/agent-controller.js";
import { agentEditingController } from "../controller/agent-editing-controller.js";
import type { AgentDefinition } from "../model/agent.js";
import type { AgentRepository } from "../interface/agent-repository.js";
import type { AgentProfileStore } from "../interface/agent-profile-store.js";

test("create and edit round-trip validated inference atomically, preserve history identity and reject invalid selections", async (context) => {
  const id = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
  let saved: AgentDefinition | undefined;
  let mutations = 0;
  const repository: AgentRepository & AgentProfileStore = {
    /** Use explicit ownership on every read and write. */
    async list({ ownerId }) {
      return saved?.ownerId === ownerId ? [saved] : [];
    },
    /** Store selections exactly as validated by the use case. */
    async create({ ownerId }, input) {
      mutations++;
      return (saved = {
        ...input,
        id,
        ownerId,
        createdAt: "2026-01-01",
        avatarId: input.avatarId ?? defaultAgentAvatarId,
        inference: input.inference ?? null,
      });
    },
    /** Missing and foreign definitions are indistinguishable. */
    async getById({ ownerId }, target) {
      return saved?.ownerId === ownerId && saved.id === target
        ? saved
        : undefined;
    },
    /** Apply the full selection in one persistence operation. */
    async update(scope, target, changes) {
      if (!(await this.getById(scope, target))) return undefined;
      mutations++;
      return (saved = { ...saved!, ...changes });
    },
    /** Delete only an owned definition. */
    async delete(scope, target) {
      if (await this.getById(scope, target)) saved = undefined;
    },
  };
  const models = {
    /** Simulate the owner's available choices without touching a runtime. */
    async validate(ownerId: string, selection: InferenceSelection) {
      assert.equal(ownerId, "owner");
      if (selection.provider === "anthropic") throw new ProviderInactiveError();
      if (
        selection.model !== "available" ||
        !["low", "high"].includes(selection.effort)
      )
        throw new InferenceSelectionError();
    },
  };
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const agents = new AgentService(repository, models);
  await agentController(app, agents, agents);
  await agentEditingController(
    app,
    new AgentEditingService(repository, models),
  );
  const inference = {
    provider: "chatgpt",
    model: "available",
    effort: "high",
  } as const;
  const created = await app.inject({
    method: "POST",
    url: "/agents",
    payload: { name: "Chosen", systemPrompt: "Help", inference },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().inference, inference);
  const changed = {
    provider: "openai-compatible",
    model: "available",
    effort: "low",
  } as const;
  const updated = await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { inference: changed },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().inference, changed);
  assert.equal(updated.json().id, id);
  assert.equal(updated.json().createdAt, created.json().createdAt);
  await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { name: "Renamed" },
  });
  assert.deepEqual(
    (await app.inject(`/agents/${id}`)).json().inference,
    changed,
  );
  const before = mutations;
  for (const inference of [
    { provider: "anthropic", model: "available", effort: "high" },
    { provider: "chatgpt", model: "unavailable", effort: "high" },
    { provider: "chatgpt", model: "available", effort: "max" },
    { provider: "chatgpt", model: "available" },
    { provider: "unknown", model: "available", effort: "high" },
    { provider: "chatgpt", model: "available", effort: "bad" },
    { provider: "chatgpt", model: " ", effort: "high" },
    { provider: "chatgpt", model: "x".repeat(201), effort: "high" },
    { ...changed, ownerId: "someone-else" },
    null,
  ]) {
    for (const method of ["POST", "PATCH"] as const) {
      const response = await app.inject({
        method,
        url: method === "POST" ? "/agents" : `/agents/${id}`,
        payload: {
          name: "Rejected",
          ...(method === "POST" ? { systemPrompt: "Help" } : {}),
          inference,
        },
      });
      assert.ok([400, 409].includes(response.statusCode), response.body);
    }
  }
  assert.equal(mutations, before);
  assert.deepEqual(saved?.inference, changed);
  const foreign = new AgentEditingService(repository, models);
  await assert.rejects(foreign.update("outsider", id, { inference }), {
    code: "AGENT_NOT_FOUND",
  });
});

test("Fast mode round-trips through create and edit, selections without a speed keep their shape, and unsupported Fast is refused before saving", async (context) => {
  const id = "0b7f2a4e-3f6d-4f41-9c3a-6e1d2b9c8a70";
  let saved: AgentDefinition | undefined;
  let mutations = 0;
  const repository: AgentRepository & AgentProfileStore = {
    /** Use explicit ownership on every read and write. */
    async list({ ownerId }) {
      return saved?.ownerId === ownerId ? [saved] : [];
    },
    /** Store selections exactly as validated, as the JSON column does. */
    async create({ ownerId }, input) {
      mutations++;
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
        ? saved
        : undefined;
    },
    /** Apply the full selection in one persistence operation. */
    async update(scope, target, changes) {
      if (!(await this.getById(scope, target))) return undefined;
      mutations++;
      return (saved = structuredClone({ ...saved!, ...changes }));
    },
    /** Delete only an owned definition. */
    async delete(scope, target) {
      if (await this.getById(scope, target)) saved = undefined;
    },
  };
  // Validate through the real capability table so the API refuses undocumented Fast models.
  const models = new ProviderModelService(
    {
      /** The owner's ChatGPT connection is active. */
      async access() {
        return { credential: {}, baseUrl: null, model: null };
      },
    },
    {
      /** The account offers one Fast-capable model and one without Fast mode. */
      async discover() {
        return [
          { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
          { id: "o3-mini", name: "o3-mini" },
        ];
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
  );
  const [sol, mini] = await models.list("owner", "chatgpt");
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const agents = new AgentService(repository, models);
  await agentController(app, agents, agents);
  await agentEditingController(
    app,
    new AgentEditingService(repository, models),
  );
  const legacy = {
    provider: "chatgpt",
    model: mini!.id,
    effort: mini!.defaultEffort,
  } as const;
  const created = await app.inject({
    method: "POST",
    url: "/agents",
    payload: { name: "Legacy", systemPrompt: "Help", inference: legacy },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().inference, legacy);
  assert.ok(!("speed" in created.json().inference));
  const fast = {
    provider: "chatgpt",
    model: sol!.id,
    effort: sol!.defaultEffort,
    speed: "fast",
  } as const;
  const edited = await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { inference: fast },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual(edited.json().inference, fast);
  assert.deepEqual(saved?.inference, fast);
  await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { name: "Renamed" },
  });
  assert.deepEqual((await app.inject(`/agents/${id}`)).json().inference, fast);
  const before = mutations;
  const refused = await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { inference: { ...legacy, speed: "fast" } },
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, "FAST_MODE_UNSUPPORTED");
  for (const speed of ["turbo", "priority", null, 1])
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/agents/${id}`,
          payload: { inference: { ...fast, speed } },
        })
      ).statusCode,
      400,
    );
  assert.equal(mutations, before);
  assert.deepEqual(saved?.inference, fast);
  const standard = {
    ...fast,
    model: mini!.id,
    effort: mini!.defaultEffort,
    speed: "standard",
  } as const;
  const turnedOff = await app.inject({
    method: "PATCH",
    url: `/agents/${id}`,
    payload: { inference: standard },
  });
  assert.equal(turnedOff.statusCode, 200);
  assert.deepEqual(turnedOff.json().inference, standard);
});
