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
    [32768, 4096],
    "unknown models stay conservative",
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
