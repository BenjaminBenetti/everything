import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderId } from "@everything/provider-contracts";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { ProviderModelService } from "../service/provider-models.js";
import { HttpModelDiscovery } from "../adapter/http-model-discovery.js";
import { providerModelController } from "../controller/provider-model-controller.js";
import { ProviderInactiveError } from "../error/provider-errors.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";

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
      /** Simulate the signed-in account's catalog. */
      async discover() {
        return [{ id: "o3-mini", name: "Account model" }];
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
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

test("compatible catalogs support keyless servers, filter non-text models, and bound explicit-model fallback", async () => {
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
        { id: "embed-model" },
        { id: "" },
      ],
    });
  });
  assert.deepEqual(await discovery.discover("openai-compatible", connection), [
    { id: "text-model", name: "text-model" },
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
  const capabilities = new PiModelCapabilities(await createModelRuntime());
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
      },
    );
});

test("compatible local model names expose their supported effort levels without changing identity", async (context) => {
  const id = "qwen3.8-flash-next-unsloth-ud-iq4_xs";
  const capabilities = new PiModelCapabilities(await createModelRuntime());
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
        efforts: ["off", "low", "medium", "xhigh"],
        defaultEffort: "medium",
      },
    ],
  });
  for (const effort of ["off", "low", "medium", "xhigh"] as const)
    await service.validate("owner", {
      provider: "openai-compatible",
      model: id,
      effort,
    });
  for (const effort of ["minimal", "high", "max"] as const)
    await assert.rejects(
      service.validate("owner", {
        provider: "openai-compatible",
        model: id,
        effort,
      }),
      { code: "INFERENCE_SELECTION_INVALID" },
    );
});

test("compatible model aliases preserve known reasoning and non-reasoning capabilities", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  for (const id of [
    "Qwen/Qwen3.8-Flash-Next",
    "unsloth/Qwen3.8-Flash-Next-GGUF:UD-IQ4_XS",
    "Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00003.gguf",
  ]) {
    const model = capabilities.describe("openai-compatible", { id, name: id });
    assert.deepEqual(model.efforts, ["off", "low", "medium", "xhigh"]);
    assert.equal(
      capabilities.resolve("openai-compatible", id, "http://local.test/v1").id,
      id,
    );
  }
  assert.deepEqual(
    capabilities.describe("openai-compatible", {
      id: "openai/o3-mini",
      name: "o3-mini",
    }).efforts,
    ["low", "medium", "high"],
  );
  for (const id of ["openai/gpt-4o", "qwen3.8-flash-next-custom-finetune"])
    assert.deepEqual(
      capabilities.describe("openai-compatible", { id, name: id }).efforts,
      ["off"],
    );
});
