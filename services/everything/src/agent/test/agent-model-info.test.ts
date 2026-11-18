import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentModelInfoService } from "../service/agent-model-info-service.js";
import { agentModelInfoController } from "../controller/agent-model-info-controller.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import {
  FastModeUnsupportedError,
  InferenceSelectionError,
  ProviderModelsError,
  UltrafastModeUnsupportedError,
} from "../../provider/error/provider-errors.js";
import {
  agents,
  agentId,
  strangerAgentId,
} from "../../attachment/test/attachment-fixtures.js";
import type { AgentDefinition } from "../model/agent.js";
import type { DiscoveredModel } from "../../provider/interface/provider-models.js";

test("model-info is owner-scoped, sanitized, and keeps selected and applied resolutions independent", async (context) => {
  const resolution = new PiModelCapabilities();
  let inference: AgentDefinition["inference"] = {
    provider: "chatgpt",
    model: "gpt-6.1-terra",
    effort: "off",
  };
  let selected: DiscoveredModel = { id: "gpt-6.1-terra", name: "Terra" };
  const applied = resolution.effective("chatgpt", selected);
  let failure: Error | undefined;
  let calls = 0;
  const service = new AgentModelInfoService(
    {
      async get(owner, id) {
        return { ...(await agents.get(owner, id)), inference };
      },
    },
    {
      async select(owner, selection) {
        assert.equal(owner, "owner");
        assert.deepEqual(selection, inference);
        calls++;
        if (failure) throw failure;
        return selected;
      },
    },
    resolution,
    {
      async appliedModel(owner, id) {
        await agents.get(owner, id);
        return applied;
      },
    },
  );
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await agentModelInfoController(app, service);
  const response = await app.inject(`/agents/${agentId}/model-info`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    selected: applied,
    applied,
    selectionError: false,
  });
  assert.deepEqual(Object.keys(response.json().applied).sort(), [
    "contextSource",
    "contextWindow",
    "imageInput",
    "imageSource",
    "model",
    "provider",
  ]);
  assert.ok(!response.body.includes("credential"));
  for (const id of [strangerAgentId, "44444444-4444-4444-8444-444444444444"])
    assert.equal(
      (await app.inject(`/agents/${id}/model-info`)).statusCode,
      404,
    );
  assert.equal(calls, 1, "inaccessible IDs do not trigger provider discovery");

  selected = { ...selected, contextWindow: 16384, imageInput: false };
  const updated = await service.read("owner", agentId);
  assert.equal(updated.selected?.contextWindow, 16384);
  assert.equal(updated.selected?.contextSource, "provider");
  assert.equal(updated.selected?.imageInput, false);
  assert.deepEqual(
    updated.applied,
    applied,
    "reading current discovery never changes pinned runtime state",
  );
  // A model list that can't be loaded says nothing about the saved model.
  failure = new ProviderModelsError();
  const unreachable = await app.inject(`/agents/${agentId}/model-info`);
  assert.deepEqual(unreachable.json(), {
    selected: null,
    applied,
    selectionError: true,
    selectionIssue: "provider",
  });
  // A model, effort, or speed the list no longer offers needs the owner's choice, and stays saved.
  for (const refusal of [
    new InferenceSelectionError(),
    new FastModeUnsupportedError(),
    new UltrafastModeUnsupportedError(),
  ]) {
    failure = refusal;
    const saved: AgentDefinition["inference"] = structuredClone(inference);
    assert.deepEqual(await service.read("owner", agentId), {
      selected: null,
      applied,
      selectionError: true,
      selectionIssue: "settings",
    });
    assert.deepEqual(inference, saved);
  }
  inference = null;
  assert.deepEqual(await service.read("owner", agentId), {
    selected: null,
    applied,
    selectionError: false,
  });
});

test("model-info for an unloaded teammate resolves budgets without starting a runtime", async () => {
  const resolution = new PiModelCapabilities();
  let selected: DiscoveredModel = {
    id: "gpt-4",
    name: "GPT-4",
    contextWindow: 8192,
  };
  const service = new AgentModelInfoService(
    {
      async get(owner, id) {
        return {
          ...(await agents.get(owner, id)),
          inference: { provider: "chatgpt", model: "gpt-4", effort: "off" },
        };
      },
    },
    {
      async select() {
        return selected;
      },
    },
    resolution,
    {
      async appliedModel() {
        return null;
      },
    },
  );
  const info = await service.read("owner", agentId);
  assert.equal(info.applied, null);
  assert.equal(info.selected?.contextWindow, 8192);
  assert.equal(info.selected?.contextSource, "provider");
  // Without a reported context, a well-known ID still gets only the planning fallback.
  selected = { id: "gpt-4", name: "GPT-4" };
  const unreported = await service.read("owner", agentId);
  assert.equal(unreported.selected?.contextWindow, 200000);
  assert.equal(unreported.selected?.contextSource, "fallback");
});
