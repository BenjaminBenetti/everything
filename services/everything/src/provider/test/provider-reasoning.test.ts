import assert from "node:assert/strict";
import { test } from "node:test";
import { inferenceEfforts } from "@everything/provider-contracts/inference";
import type { ProviderId } from "@everything/provider-contracts";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { HttpModelDiscovery } from "../adapter/http-model-discovery.js";
import { providerModelController } from "../controller/provider-model-controller.js";
import { ProviderModelService } from "../service/provider-models.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";

/** Codex-shaped reasoning entries for the given provider values. */
function levels(
  ...efforts: string[]
): { effort: string; description: string }[] {
  return efforts.map((effort) => ({ effort, description: effort }));
}

/** An Anthropic capability flag. */
const support = (supported: boolean) => ({ supported });

/**
 * A model service over real HTTP discovery and Pi capabilities, answering each provider's model
 * list with `catalog` and recording every URL requested.
 */
async function service(
  provider: ProviderId,
  catalog: unknown,
  requests: URL[] = [],
): Promise<ProviderModelService> {
  return new ProviderModelService(
    {
      /** One owner holds every provider's credentials. */
      async access() {
        return {
          credential:
            provider === "chatgpt"
              ? { accessToken: "chatgpt-token" }
              : { apiKey: "claude-key" },
          baseUrl: null,
          model: null,
        };
      },
    },
    new HttpModelDiscovery(async (input) => {
      requests.push(new URL(String(input)));
      return Response.json(catalog);
    }),
    new PiModelCapabilities(await createModelRuntime()),
  );
}

/** Assert that exactly `accepted` efforts validate for this model. */
async function assertAccepted(
  models: ProviderModelService,
  provider: ProviderId,
  model: string,
  accepted: readonly string[],
): Promise<void> {
  for (const effort of inferenceEfforts) {
    const selection = { provider, model, effort };
    if (accepted.includes(effort)) await models.validate("owner", selection);
    else
      await assert.rejects(
        models.validate("owner", selection),
        { code: "INFERENCE_SELECTION_INVALID" },
        `${model} ${effort}`,
      );
  }
}

test("a ChatGPT model missing from Pi's catalog offers exactly the levels its account catalog lists", async (context) => {
  const requests: URL[] = [];
  const models = await service(
    "chatgpt",
    {
      models: [
        {
          slug: "gpt-6.1-terra",
          display_name: "GPT-6.1 Terra",
          visibility: "list",
          supported_reasoning_levels: levels("low", "medium", "xhigh", "ultra"),
          default_reasoning_level: "xhigh",
        },
      ],
    },
    requests,
  );
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await providerModelController(app, models);
  const response = await app.inject("/providers/chatgpt/models");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    models: [
      {
        id: "gpt-6.1-terra",
        name: "GPT-6.1 Terra",
        efforts: ["low", "medium", "xhigh"],
        defaultEffort: "xhigh",
        effortSource: "provider",
        speeds: ["standard"],
      },
    ],
  });
  assert.ok(!response.body.includes("ultra"));
  assert.ok(!response.body.includes("chatgpt-token"));
  await assertAccepted(models, "chatgpt", "gpt-6.1-terra", [
    "low",
    "medium",
    "xhigh",
  ]);
  // Discovery, listing and every validation use only the API audience's own host.
  assert.ok(requests.length > 0);
  for (const url of requests)
    assert.equal(url.href, "https://api.openai.com/v1/models");
});

test("a ChatGPT model with no listed levels and no catalog entry gets no guessed effort support", async () => {
  for (const entry of [
    {},
    { supported_reasoning_levels: "low" },
    { supported_reasoning_levels: [{ effort: "low" }, { level: "high" }] },
  ]) {
    const models = await service("chatgpt", {
      models: [{ slug: "gpt-6.1-terra", visibility: "list", ...entry }],
    });
    const [model] = await models.list("owner", "chatgpt");
    assert.deepEqual(
      { efforts: model!.efforts, source: model!.effortSource },
      { efforts: ["off"], source: "unknown" },
    );
    await assertAccepted(models, "chatgpt", "gpt-6.1-terra", ["off"]);
  }
});

test("listed ChatGPT levels override Pi's catalog, which remains the fallback when none are listed", async () => {
  const listed = await service("chatgpt", {
    models: [
      {
        slug: "gpt-5.6-terra",
        visibility: "list",
        supported_reasoning_levels: levels("none", "medium", "high"),
      },
    ],
  });
  const [narrowed] = await listed.list("owner", "chatgpt");
  assert.deepEqual(narrowed!.efforts, ["off", "medium", "high"]);
  assert.equal(narrowed!.defaultEffort, "medium");
  assert.equal(narrowed!.effortSource, "provider");
  await assertAccepted(listed, "chatgpt", "gpt-5.6-terra", [
    "off",
    "medium",
    "high",
  ]);
  for (const entry of [{}, { supported_reasoning_levels: [null] }]) {
    const fallback = await service("chatgpt", {
      models: [{ slug: "gpt-5.6-terra", visibility: "list", ...entry }],
    });
    const [model] = await fallback.list("owner", "chatgpt");
    assert.deepEqual(model!.efforts, [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.equal(model!.effortSource, "catalog");
  }
});

test("a ChatGPT model listing only levels the runtime can't send runs at the provider default", async () => {
  const models = await service("chatgpt", {
    models: [
      {
        slug: "gpt-5.6-terra",
        visibility: "list",
        supported_reasoning_levels: levels("ultra"),
      },
    ],
  });
  const [model] = await models.list("owner", "chatgpt");
  assert.deepEqual(
    { efforts: model!.efforts, source: model!.effortSource },
    { efforts: ["off"], source: "provider" },
  );
});

test("Claude models use their reported effort levels only where the runtime sends an effort", async () => {
  const effort = {
    supported: true,
    low: support(true),
    medium: support(true),
    high: support(true),
    xhigh: null,
    max: support(true),
  };
  const capabilities = {
    effort,
    thinking: { supported: true, types: { adaptive: support(true) } },
  };
  const requests: URL[] = [];
  const models = await service(
    "anthropic",
    {
      data: [
        // Missing from Pi's catalog: its reported levels are the only ones offered.
        { id: "claude-next", display_name: "Claude Next", capabilities },
        // Adaptive in Pi's catalog: the reported null xhigh removes it.
        { id: "claude-opus-4-8", display_name: "Opus 4.8", capabilities },
        // Token-budget thinking in Pi's catalog: effort levels aren't Anthropic's to describe.
        { id: "claude-sonnet-4-5", display_name: "Sonnet 4.5", capabilities },
        // No capabilities: Pi's catalog applies.
        { id: "claude-opus-5-5", display_name: "Opus 5.5", capabilities: null },
      ].map((model) => ({ ...model, type: "model", created_at: "2026-01-01" })),
      has_more: false,
      first_id: null,
      last_id: null,
    },
    requests,
  );
  const listed = Object.fromEntries(
    (await models.list("owner", "anthropic")).map((model) => [
      model.id,
      [model.effortSource, model.efforts],
    ]),
  );
  assert.deepEqual(listed, {
    "claude-next": ["provider", ["low", "medium", "high", "max"]],
    "claude-opus-4-8": [
      "provider",
      ["off", "minimal", "low", "medium", "high", "max"],
    ],
    "claude-sonnet-4-5": [
      "catalog",
      ["off", "minimal", "low", "medium", "high"],
    ],
    "claude-opus-5-5": ["catalog", ["low", "medium", "high", "xhigh", "max"]],
  });
  await assertAccepted(models, "anthropic", "claude-next", [
    "low",
    "medium",
    "high",
    "max",
  ]);
  for (const url of requests)
    assert.equal(url.origin, "https://api.anthropic.com");
});
