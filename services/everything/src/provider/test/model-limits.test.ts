import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advertisedLimits,
  serverPropsLimits,
} from "../adapter/advertised-model-limits.js";
import { HttpModelDiscovery } from "../adapter/http-model-discovery.js";
import { ProviderModelService } from "../service/provider-models.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";

/** Malformed wire values must remain unknown even when they bypass discovery's parser. */
const invalidLimits: readonly unknown[] = [
  undefined,
  null,
  "200000",
  true,
  {},
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  100_000_001,
  Number.MAX_SAFE_INTEGER,
];

test("model lists report limits under each common server's field names", () => {
  for (const [entry, expected] of [
    [{ meta: { n_ctx: 262144 } }, { contextWindow: 262144 }],
    [{ max_model_len: 131072 }, { contextWindow: 131072 }],
    [
      { context_window: 131072, max_completion_tokens: 32768 },
      { contextWindow: 131072, maxOutputTokens: 32768 },
    ],
    [
      {
        context_length: 200000,
        top_provider: { context_length: 163840, max_completion_tokens: 16384 },
      },
      { contextWindow: 163840, maxOutputTokens: 16384 },
    ],
    [
      { max_context_length: 131072, loaded_context_length: 16384 },
      { contextWindow: 16384 },
    ],
    [{ metadata: { context_length: 65536 } }, { contextWindow: 65536 }],
  ] as const)
    assert.deepEqual(advertisedLimits(entry), expected, JSON.stringify(entry));
});

test("training context, malformed values, and missing fields leave limits unknown", () => {
  for (const entry of [
    { meta: { n_ctx_train: 262144 } },
    { max_model_len: "131072" },
    { context_length: -1 },
    { context_length: 1.5 },
    { context_length: 1e12 },
    { meta: null },
    null,
    "model",
  ])
    assert.deepEqual(advertisedLimits(entry), {}, JSON.stringify(entry));
  for (const value of invalidLimits)
    assert.deepEqual(
      advertisedLimits({ context_window: value, max_output_tokens: value }),
      {},
      String(value),
    );
});

test("llama.cpp props give the running context, and a response cap only when one is set", () => {
  assert.deepEqual(
    serverPropsLimits({
      default_generation_settings: { n_ctx: 65536, params: { n_predict: -1 } },
    }),
    { contextWindow: 65536 },
  );
  assert.deepEqual(
    serverPropsLimits({
      default_generation_settings: {
        n_ctx: 65536,
        params: { n_predict: 8192 },
      },
    }),
    { contextWindow: 65536, maxOutputTokens: 8192 },
  );
});

test("compatible discovery keeps each model's reported limits", async () => {
  const requested: string[] = [];
  const discovery = new HttpModelDiscovery(async (input, init) => {
    requested.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer key");
    return Response.json({
      data: [{ id: "large", meta: { n_ctx: 262144 } }, { id: "plain" }],
    });
  });
  assert.deepEqual(
    await discovery.discover("openai-compatible", {
      credential: { apiKey: "key" },
      baseUrl: "http://model.test/v1",
      model: null,
    }),
    [
      { id: "large", name: "large", contextWindow: 262144 },
      { id: "plain", name: "plain" },
    ],
  );
  assert.deepEqual(requested, ["http://model.test/v1/models"]);
});

test("ChatGPT preserves validated optional limits without requiring them in its account catalog", async () => {
  const requested: string[] = [];
  const discovery = new HttpModelDiscovery(async (input, init) => {
    requested.push(String(input));
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer oauth-test",
    );
    assert.equal(init?.redirect, "error");
    return Response.json({
      models: [
        {
          slug: "reported",
          visibility: "list",
          context_window: 65536,
          max_output_tokens: 8192,
        },
        { slug: "plain", display_name: "Plain", visibility: "list" },
        {
          slug: "invalid",
          visibility: "list",
          context_window: -1,
          max_output_tokens: "8192",
        },
        { slug: "hidden", visibility: "hide", context_window: 262144 },
      ],
    });
  });
  assert.deepEqual(
    await discovery.discover("chatgpt", {
      credential: { accessToken: "oauth-test" },
      baseUrl: null,
      model: null,
    }),
    [
      {
        id: "reported",
        name: "reported",
        contextWindow: 65536,
        maxOutputTokens: 8192,
      },
      { id: "plain", name: "Plain" },
      { id: "invalid", name: "invalid" },
    ],
  );
  assert.deepEqual(requested, ["https://api.openai.com/v1/models"]);
});

test("a single-model server without listed limits is asked for llama.cpp's running limits", async () => {
  const connection = {
    credential: { apiKey: "key" },
    baseUrl: "http://model.test/v1",
    model: null,
  };
  const discovery = (props: () => Promise<Response>) =>
    new HttpModelDiscovery(async (input, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer key",
      );
      if (String(input) === "http://model.test/props") return props();
      return Response.json({
        data: [{ id: "local", meta: { n_ctx_train: 262144 } }],
      });
    });
  assert.deepEqual(
    await discovery(async () =>
      Response.json({
        default_generation_settings: {
          n_ctx: 32768,
          params: { n_predict: -1 },
        },
      }),
    ).discover("openai-compatible", connection),
    [{ id: "local", name: "local", contextWindow: 32768 }],
  );
  for (const props of [
    async () => new Response(null, { status: 404 }),
    async () => new Response("not json"),
    async () => {
      throw new Error("offline");
    },
  ])
    assert.deepEqual(
      await discovery(props).discover("openai-compatible", connection),
      [{ id: "local", name: "local" }],
    );
});

test("reported limits set the runtime context and response room, ahead of the catalog", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const resolve = (limits?: {
    contextWindow?: number;
    maxOutputTokens?: number;
  }) => {
    const model = capabilities.resolve(
      "openai-compatible",
      "qwen3.8-flash-next-unsloth-ud-iq4_xs",
      "http://model.test/v1",
      limits,
    );
    return [model.contextWindow, model.maxTokens];
  };
  assert.deepEqual(
    resolve(),
    [200000, 4096],
    "only an unknown context uses the decimal 200,000-token planning fallback",
  );
  assert.deepEqual(resolve({ contextWindow: 262144 }), [262144, 32768]);
  assert.deepEqual(resolve({ contextWindow: 16384 }), [16384, 4096]);
  assert.deepEqual(
    resolve({ contextWindow: 262144, maxOutputTokens: 65536 }),
    [262144, 65536],
  );
  assert.deepEqual(
    resolve({ contextWindow: 8192, maxOutputTokens: 65536 }),
    [8192, 8192],
    "a response never exceeds the context",
  );
  const known = capabilities.resolve("openai-compatible", "o3-mini", "");
  const smaller = capabilities.resolve("openai-compatible", "o3-mini", "", {
    contextWindow: 16384,
  });
  assert.ok(known.contextWindow > 16384);
  assert.equal(
    smaller.contextWindow,
    16384,
    "the running server wins over the catalog",
  );
});

test("provider limits take priority while an exact small catalog model stays below the fallback", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  const catalog = capabilities.resolve(
    "chatgpt",
    "gpt-4",
    "https://api.openai.com/v1",
  );
  assert.equal(catalog.contextWindow, 8192);
  assert.equal(catalog.maxTokens, 8192);
  const advertised = capabilities.resolve("chatgpt", "gpt-4", catalog.baseUrl, {
    contextWindow: 4096,
    maxOutputTokens: 1024,
  });
  assert.equal(advertised.contextWindow, 4096);
  assert.equal(advertised.maxTokens, 1024);
  assert.equal(advertised.id, catalog.id);
  assert.equal(advertised.provider, "openai");
  assert.equal(advertised.api, "openai-responses");
  assert.equal(advertised.baseUrl, catalog.baseUrl);
});

test("invalid advertised limits fall back independently to the catalog or unknown defaults", async () => {
  const capabilities = new PiModelCapabilities(await createModelRuntime());
  for (const value of invalidLimits) {
    const limits = {
      contextWindow: value as number,
      maxOutputTokens: value as number,
    };
    const known = capabilities.resolve("chatgpt", "gpt-4", "", limits);
    assert.deepEqual(
      [known.contextWindow, known.maxTokens],
      [8192, 8192],
      String(value),
    );
    const unknown = capabilities.resolve(
      "chatgpt",
      "unlisted-context-fixture",
      "",
      limits,
    );
    assert.deepEqual(
      [unknown.contextWindow, unknown.maxTokens],
      [200000, 4096],
      String(value),
    );
    const contextOnly = capabilities.resolve(
      "chatgpt",
      "unlisted-context-fixture",
      "",
      {
        ...limits,
        contextWindow: 65536,
      },
    );
    assert.deepEqual(
      [contextOnly.contextWindow, contextOnly.maxTokens],
      [65536, 16384],
    );
    const outputOnly = capabilities.resolve(
      "chatgpt",
      "unlisted-context-fixture",
      "",
      {
        ...limits,
        maxOutputTokens: 2048,
      },
    );
    assert.deepEqual(
      [outputOnly.contextWindow, outputOnly.maxTokens],
      [200000, 2048],
    );
  }
});

test("invalid catalog limits cannot propagate into resolved budgets", async () => {
  const original = (await createModelRuntime()).getModel("openai", "gpt-4");
  assert.ok(original);
  for (const value of invalidLimits) {
    const malformed = {
      ...original,
      contextWindow: value as number,
      maxTokens: value as number,
    };
    const capabilities = new PiModelCapabilities({
      getModel: () => malformed,
      getModels: () => [malformed],
    });
    const model = capabilities.resolve(
      "chatgpt",
      original.id,
      original.baseUrl,
    );
    assert.deepEqual(
      [model.contextWindow, model.maxTokens],
      [200000, 4096],
      String(value),
    );
  }
});

test("selection returns reported limits while the public catalog keeps only safe fields", async () => {
  const service = new ProviderModelService(
    {
      async access() {
        return {
          credential: { apiKey: "key" },
          baseUrl: "http://model.test/v1",
          model: null,
        };
      },
    },
    {
      async discover() {
        return [
          {
            id: "local",
            name: "local",
            contextWindow: 262144,
            maxOutputTokens: 8192,
          },
        ];
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
  );
  const [listed] = await service.list("owner", "openai-compatible");
  assert.deepEqual(Object.keys(listed!).sort(), [
    "defaultEffort",
    "effortSource",
    "efforts",
    "id",
    "name",
    "speeds",
  ]);
  const selected = await service.select("owner", {
    provider: "openai-compatible",
    model: "local",
    effort: listed!.defaultEffort,
  });
  assert.equal(selected.contextWindow, 262144);
  assert.equal(selected.maxOutputTokens, 8192);
  await assert.rejects(
    service.select("owner", {
      provider: "openai-compatible",
      model: "missing",
      effort: listed!.defaultEffort,
    }),
  );
});
