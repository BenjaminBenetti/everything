import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderId } from "@everything/provider-contracts";
import type { InferenceEffort } from "@everything/provider-contracts/inference";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { ProviderModelService } from "../service/provider-models.js";
import { HttpModelDiscovery } from "../adapter/http-model-discovery.js";
import { providerModelController } from "../controller/provider-model-controller.js";
import { ProviderInactiveError } from "../error/provider-errors.js";
import { compatibleTextOutput } from "../adapter/advertised-text-output.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";

test("model discovery applies ownership, validates model-specific efforts, and exposes safe metadata", async (context) => {
  const calls: unknown[] = [];
  const service = new ProviderModelService(
    {
      /** Allow one owner and active provider, proving catalogs do not imply access. */
      async access(ownerId, provider) {
        calls.push([ownerId, provider]);
        if (ownerId !== "owner" || provider !== "chatgpt")
          throw new ProviderInactiveError();
        return {
          credential: { accessToken: "private-token" },
          baseUrl: null,
          model: null,
        };
      },
    },
    {
      /** Simulate the signed-in account's catalog, which lists the model's effort levels. */
      async discover() {
        return [
          {
            id: "o3-mini",
            name: "Account model",
            reasoning: {
              levels: {
                off: null,
                minimal: null,
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: null,
                max: null,
              },
            },
          },
        ];
      },
    },
    new PiModelCapabilities(),
  );
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await providerModelController(app, service);
  const response = await app.inject("/providers/chatgpt/models");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    models: [
      {
        id: "o3-mini",
        name: "Account model",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        effortSource: "provider",
        speeds: ["standard"],
      },
    ],
  });
  assert.ok(!response.body.includes("private-token"));
  assert.deepEqual(calls, [["owner", "chatgpt"]]);
  assert.equal((await app.inject("/providers/unknown/models")).statusCode, 400);
  assert.equal(
    (await app.inject("/providers/anthropic/models")).statusCode,
    409,
  );
  await assert.rejects(service.list("outsider", "chatgpt"), {
    code: "PROVIDER_INACTIVE",
  });
  await service.validate("owner", {
    provider: "chatgpt",
    model: "o3-mini",
    effort: "high",
  });
  for (const choice of [
    { model: "o3-mini", effort: "off" },
    { model: "unavailable", effort: "high" },
  ] as const)
    await assert.rejects(
      service.validate("owner", { provider: "chatgpt", ...choice }),
      { code: "INFERENCE_SELECTION_INVALID" },
    );
});

test("catalog failures never expose upstream secrets and do not invent fallback models", async () => {
  const service = new ProviderModelService(
    {
      /** Supply connection metadata for discovery. */
      async access() {
        return {
          credential: { apiKey: "secret" },
          baseUrl: "https://example.test/v1",
          model: null,
        };
      },
    },
    {
      /** Simulate a sensitive upstream error. */
      async discover() {
        throw new Error("secret response body");
      },
    },
    {
      /** No choices should be constructed after a failed discovery request. */
      describe() {
        throw new Error("Unexpected capability lookup");
      },
    },
  );
  await assert.rejects(service.list("owner", "anthropic"), (error: unknown) => {
    assert.equal(
      (error as { code: string }).code,
      "PROVIDER_MODELS_UNAVAILABLE",
    );
    assert.ok(!(error as Error).message.includes("secret"));
    return true;
  });
});

test("ChatGPT discovery uses the account catalog, display names, visibility and server order", async () => {
  const discovery = new HttpModelDiscovery(async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/models");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer owner-token",
    );
    assert.equal(init?.redirect, "error");
    return Response.json({
      models: [
        { slug: "second", display_name: "First choice", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hide" },
        { slug: "first", display_name: "Second choice", visibility: "list" },
      ],
    });
  });
  assert.deepEqual(
    await discovery.discover("chatgpt", {
      credential: { accessToken: "owner-token" },
      baseUrl: null,
      model: null,
    }),
    [
      { id: "second", name: "First choice" },
      { id: "first", name: "Second choice" },
    ],
  );
});

test("compatible catalogs support keyless servers, drop models the server says don't write text, and bound explicit-model fallback", async () => {
  const connection = {
    credential: {},
    baseUrl: "http://model.test/v1",
    model: "configured-model",
  };
  const discovery = new HttpModelDiscovery(async (input, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    // A single listed model also prompts a look at llama.cpp's running limits.
    if (String(input) === "http://model.test/props")
      return new Response(null, { status: 404 });
    assert.equal(String(input), "http://model.test/v1/models");
    return Response.json({
      data: [
        { id: "text-model" },
        { id: "text-model" },
        // A name says nothing about a model: one the server doesn't describe stays listed.
        { id: "embed-model" },
        { id: "whisper-chat", architecture: { output_modalities: ["text"] } },
        { id: "image-maker", architecture: { output_modalities: ["image"] } },
        { id: "malformed-output", architecture: { output_modalities: [1] } },
        { id: "" },
      ],
    });
  });
  assert.deepEqual(await discovery.discover("openai-compatible", connection), [
    { id: "text-model", name: "text-model" },
    { id: "embed-model", name: "embed-model" },
    { id: "whisper-chat", name: "whisper-chat" },
    { id: "malformed-output", name: "malformed-output" },
  ]);
  for (const status of [404, 405, 501]) {
    const fallback = new HttpModelDiscovery(
      async () => new Response(null, { status }),
    );
    assert.deepEqual(await fallback.discover("openai-compatible", connection), [
      { id: "configured-model", name: "configured-model" },
    ]);
  }
  for (const status of [401, 403, 500]) {
    const failure = new HttpModelDiscovery(
      async () => new Response(null, { status }),
    );
    await assert.rejects(failure.discover("openai-compatible", connection));
  }
});

test("compatible output modalities say whether a model writes text, and anything else is unknown", () => {
  /** A model-list entry declaring `modalities` as its outputs. */
  const entry = (modalities: unknown) => ({
    id: "any",
    architecture: { output_modalities: modalities },
  });
  assert.equal(compatibleTextOutput(entry(["text"])), true);
  assert.equal(compatibleTextOutput(entry(["image", "text"])), true);
  assert.equal(compatibleTextOutput(entry(["image"])), false);
  assert.equal(compatibleTextOutput(entry(["embeddings"])), false);
  for (const malformed of [
    undefined,
    null,
    "text",
    [],
    [""],
    ["text", 1],
    ["text", null],
    Array(17).fill("text"),
  ])
    assert.equal(
      compatibleTextOutput(entry(malformed)),
      undefined,
      JSON.stringify(malformed),
    );
  for (const missing of [
    null,
    {},
    { id: "embed-model" },
    { architecture: null },
  ])
    assert.equal(compatibleTextOutput(missing), undefined);
});

test("Claude discovery follows authenticated model pagination", async () => {
  let requests = 0;
  const discovery = new HttpModelDiscovery(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("x-api-key"), "claude-key");
    requests++;
    if (requests === 2) assert.equal(url.searchParams.get("after_id"), "one");
    const id = requests === 1 ? "one" : "two";
    return Response.json({
      data: [
        {
          id,
          display_name: id.toUpperCase(),
          type: "model",
          created_at: "2026-01-01",
        },
      ],
      first_id: id,
      last_id: id,
      has_more: requests === 1,
    });
  });
  assert.deepEqual(
    await discovery.discover("anthropic", {
      credential: { apiKey: "claude-key" },
      baseUrl: null,
      model: null,
    }),
    [
      { id: "one", name: "ONE" },
      { id: "two", name: "TWO" },
    ],
  );
  assert.equal(requests, 2);
});

test("unknown models offer only the runtime default instead of guessed effort support", async () => {
  const capabilities = new PiModelCapabilities();
  for (const provider of [
    "anthropic",
    "chatgpt",
    "openai-compatible",
  ] satisfies ProviderId[])
    assert.deepEqual(
      capabilities.describe(provider, {
        id: "new-custom-model",
        name: "Custom",
      }),
      {
        id: "new-custom-model",
        name: "Custom",
        efforts: ["off"],
        defaultEffort: "off",
        effortSource: "unknown",
        speeds: ["standard"],
      },
    );
});

test("compatible model names never imply effort levels, and keep their exact identity", async (context) => {
  const id = "qwen3.8-flash-next-unsloth-ud-iq4_xs";
  const capabilities = new PiModelCapabilities();
  const service = new ProviderModelService(
    {
      /** Supply the local owner's connection without requiring an inference request. */
      async access(ownerId, provider) {
        assert.equal(ownerId, "owner");
        assert.equal(provider, "openai-compatible");
        return {
          credential: {},
          baseUrl: "http://local.test/v1",
          model: id,
        };
      },
    },
    new HttpModelDiscovery(async () =>
      Response.json({ data: [{ id, meta: { n_ctx: 262144 } }] }),
    ),
    capabilities,
  );
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await providerModelController(app, service);
  const response = await app.inject("/providers/openai-compatible/models");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    models: [
      {
        id,
        name: id,
        efforts: ["off"],
        defaultEffort: "off",
        effortSource: "unknown",
        speeds: ["standard"],
      },
    ],
  });
  await service.validate("owner", {
    provider: "openai-compatible",
    model: id,
    effort: "off",
  });
  for (const effort of [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const)
    await assert.rejects(
      service.validate("owner", {
        provider: "openai-compatible",
        model: id,
        effort,
      }),
      { code: "INFERENCE_SELECTION_INVALID" },
    );
});

test("compatible names of catalog models get nothing from Pi's catalog", async () => {
  const capabilities = new PiModelCapabilities();
  const ids = [
    "Qwen/Qwen3.8-Flash-Next",
    "unsloth/Qwen3.8-Flash-Next-GGUF:UD-IQ4_XS",
    "Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00003.gguf",
    "openai/o3-mini",
    "openai/gpt-4o",
    "anthropic/claude-opus-5-5",
    "new-opaque-model",
  ];
  const [reference, ...rest] = ids.map((id) => {
    const {
      id: resolvedId,
      name,
      resolution,
      ...model
    } = capabilities.resolve("openai-compatible", id, "http://local.test/v1");
    assert.equal(resolvedId, id);
    assert.equal(name, id);
    assert.equal(resolution.model, id);
    assert.deepEqual(
      capabilities.describe("openai-compatible", { id, name: id }).efforts,
      ["off"],
      id,
    );
    return { ...model, resolution: { ...resolution, model: "" } };
  });
  // Every name resolves to the very same model, apart from its identity.
  for (const model of rest) assert.deepEqual(model, reference);
  assert.deepEqual(
    [
      reference!.reasoning,
      reference!.input,
      reference!.resolution.contextSource,
      reference!.resolution.imageSource,
    ],
    [false, ["text"], "fallback", "unknown"],
  );
});

test("Fast mode is offered and accepted only where the account's model list offers it, and selections without a speed stay standard", async () => {
  const catalogs: Record<ProviderId, string[]> = {
    chatgpt: [
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-5.6-terra",
      "gpt-6.2-sol-2026-11-17",
      "gpt-5.5",
      "o3-mini",
      "toString",
    ],
    anthropic: [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-6",
      "Claude-Opus-5-5",
    ],
    "openai-compatible": ["claude-opus-5-5", "gpt-6.1-sol"],
  };
  /** A model whose metadata lists Fast, which only ChatGPT sign-in's model list can report. */
  const listed: Record<ProviderId, string> = {
    chatgpt: "gpt-next-opaque",
    anthropic: "claude-next-opaque",
    "openai-compatible": "local-next-opaque",
  };
  const service = new ProviderModelService(
    {
      /** Every provider is connected; availability is covered by the ownership test. */
      async access() {
        return { credential: {}, baseUrl: "http://local.test/v1", model: null };
      },
    },
    {
      /** Each account lists models with no speed metadata, beside one that lists Fast. */
      async discover(provider) {
        return [
          ...catalogs[provider].map((id) => ({ id, name: id })),
          {
            id: listed[provider],
            name: listed[provider],
            speeds: { offered: ["fast" as const], complete: false },
          },
        ];
      },
    },
    new PiModelCapabilities(),
  );
  for (const provider of Object.keys(catalogs) as ProviderId[]) {
    const models = await service.list("owner", provider);
    for (const model of models) {
      const supported = provider === "chatgpt" && model.id === listed.chatgpt;
      assert.deepEqual(
        model.speeds,
        supported ? ["standard", "fast"] : ["standard"],
        `${provider} ${model.id}`,
      );
      const selection = {
        provider,
        model: model.id,
        effort: model.defaultEffort,
      };
      await service.validate("owner", selection);
      await service.validate("owner", { ...selection, speed: "standard" });
      if (supported)
        await service.validate("owner", { ...selection, speed: "fast" });
      else
        await assert.rejects(
          service.validate("owner", { ...selection, speed: "fast" }),
          { code: "FAST_MODE_UNSUPPORTED" },
        );
      // A legacy list offers Fast only; only a complete list can offer Ultrafast.
      await assert.rejects(
        service.validate("owner", { ...selection, speed: "ultrafast" }),
        { code: "ULTRAFAST_MODE_UNSUPPORTED" },
      );
    }
  }
});

test("each account's model list decides its Fast and Ultrafast choices on every request", async (context) => {
  /** Codex-shaped service tiers, with display text that must never reach the public catalog. */
  const tiers = (...ids: string[]) =>
    ids.map((id) => ({ id, name: `${id} name`, description: `${id} blurb` }));
  const entry = (slug: string, metadata: Record<string, unknown> = {}) => ({
    slug,
    display_name: slug,
    visibility: "list",
    ...metadata,
  });
  const accounts: Record<string, unknown> = {
    "token-pro": {
      models: [
        entry("gpt-6.2-sol", { service_tiers: tiers("priority", "ultrafast") }),
        // A listed default tier is never a reason to offer or send a paid speed.
        entry("gpt-6.2-astra", {
          service_tiers: tiers("priority", "flex"),
          default_service_tier: "ultrafast",
        }),
        // An explicit empty list offers no paid speed.
        entry("gpt-6.1-sol", { service_tiers: [] }),
        // The account list can offer Fast for a model no documentation names yet.
        entry("gpt-6.3-sol", { service_tiers: tiers("priority") }),
        // No speed metadata: standard only, whatever documentation says about the model.
        entry("gpt-6.1-terra"),
        // The deprecated list adds Fast; malformed tiers report nothing, so no paid speed is offered.
        entry("gpt-6-luna", { additional_speed_tiers: ["fast"] }),
        entry("gpt-6-astra", { service_tiers: [{ id: "ultrafast" }, null] }),
        entry("gpt-6.3-luna", { additional_speed_tiers: [] }),
      ],
    },
    "token-plus": {
      models: [entry("gpt-6.2-sol", { service_tiers: tiers("priority") })],
    },
  };
  const tokens: Record<string, string> = {
    owner: "token-pro",
    other: "token-plus",
  };
  const requests: string[] = [];
  const service = new ProviderModelService(
    {
      /** Each owner's ChatGPT connection signs in to its own account. */
      async access(ownerId) {
        return {
          credential: { accessToken: tokens[ownerId]! },
          baseUrl: null,
          model: null,
        };
      },
    },
    new HttpModelDiscovery(async (input, init) => {
      const token = new Headers(init?.headers)
        .get("authorization")!
        .replace("Bearer ", "");
      requests.push(`${String(input)} ${token}`);
      return Response.json(accounts[token]);
    }),
    new PiModelCapabilities(),
  );
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await providerModelController(app, service);
  const response = await app.inject("/providers/chatgpt/models");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    Object.fromEntries(
      (response.json().models as { id: string; speeds: string[] }[]).map(
        (model) => [model.id, model.speeds],
      ),
    ),
    {
      "gpt-6.2-sol": ["standard", "fast", "ultrafast"],
      "gpt-6.2-astra": ["standard", "fast"],
      "gpt-6.1-sol": ["standard"],
      "gpt-6.3-sol": ["standard", "fast"],
      "gpt-6.1-terra": ["standard"],
      "gpt-6-luna": ["standard", "fast"],
      "gpt-6-astra": ["standard"],
      "gpt-6.3-luna": ["standard"],
    },
  );
  for (const leaked of [" name", "blurb", "flex", "token-"])
    assert.ok(!response.body.includes(leaked), leaked);

  const efforts = new Map(
    (
      response.json().models as { id: string; defaultEffort: InferenceEffort }[]
    ).map((model) => [model.id, model.defaultEffort]),
  );
  /** A selection of `model` at `speed` with its default effort. */
  const choice = (model: string, speed: "fast" | "ultrafast") => ({
    provider: "chatgpt" as const,
    model,
    effort: efforts.get(model)!,
    speed,
  });
  const ultrafast = await service.select(
    "owner",
    choice("gpt-6.2-sol", "ultrafast"),
  );
  // Validation returns the listed speeds, so a runtime sends what was validated.
  assert.deepEqual(ultrafast.speeds, {
    offered: ["fast", "ultrafast"],
    complete: true,
  });
  await service.validate("owner", choice("gpt-6.3-sol", "fast"));
  for (const [ownerId, model, speed, code] of [
    ["owner", "gpt-6.2-astra", "ultrafast", "ULTRAFAST_MODE_UNSUPPORTED"],
    ["owner", "gpt-6-astra", "ultrafast", "ULTRAFAST_MODE_UNSUPPORTED"],
    ["owner", "gpt-6.1-sol", "fast", "FAST_MODE_UNSUPPORTED"],
    ["owner", "gpt-6.3-luna", "fast", "FAST_MODE_UNSUPPORTED"],
    // Another owner's account is checked against its own list.
    ["other", "gpt-6.2-sol", "ultrafast", "ULTRAFAST_MODE_UNSUPPORTED"],
  ] as const)
    await assert.rejects(service.validate(ownerId, choice(model, speed)), {
      code,
    });
  await service.validate("other", choice("gpt-6.2-sol", "fast"));

  // Signing in to a different account changes the choices at once: nothing is cached.
  tokens.owner = "token-plus";
  await assert.rejects(
    service.validate("owner", choice("gpt-6.2-sol", "ultrafast")),
    { code: "ULTRAFAST_MODE_UNSUPPORTED" },
  );
  assert.deepEqual(
    (await service.list("owner", "chatgpt")).map((model) => model.speeds),
    [["standard", "fast"]],
  );
  assert.equal(requests.length, 11);
  assert.ok(
    requests.every((request) =>
      request.startsWith("https://api.openai.com/v1/models token-"),
    ),
  );
});
