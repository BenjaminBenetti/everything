import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { Context, Tool } from "@earendil-works/pi-ai";
import type { ProviderId } from "@everything/provider-contracts";
import type { InferenceEffort } from "@everything/provider-contracts/inference";
import { HttpModelDiscovery } from "../../provider/adapter/http-model-discovery.js";
import { ProviderModelService } from "../../provider/service/provider-models.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";

// ===========================================
// Fixtures
// ===========================================

/** Encode provider events as a server-sent event response for the native SDKs. */
function events(items: Record<string, unknown>[], named = true): Response {
  return new Response(
    items
      .map((item) =>
        named
          ? `event: ${String(item.type)}\ndata: ${JSON.stringify(item)}\n\n`
          : `data: ${JSON.stringify(item)}\n\n`,
      )
      .join("") + (named ? "" : "data: [DONE]\n\n"),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A completed reply in each provider's streaming protocol. */
function reply(provider: ProviderId, model: string): Response {
  if (provider === "chatgpt")
    return events([
      { type: "response.created", response: { id: "response" } },
      {
        type: "response.completed",
        response: { id: "response", status: "completed", output: [] },
      },
    ]);
  if (provider === "anthropic")
    return events([
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
  return events(
    [
      {
        id: "completion",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          { index: 0, delta: { content: "Done" }, finish_reason: "stop" },
        ],
      },
    ],
    false,
  );
}

/** One provider's model list holding `entry` under `id`, in that provider's response shape. */
function modelList(provider: ProviderId, id: string, entry: object): unknown {
  if (provider === "chatgpt")
    return { models: [{ slug: id, visibility: "list", ...entry }] };
  if (provider === "anthropic")
    return {
      data: [
        {
          id,
          display_name: id,
          type: "model",
          created_at: "2026-01-01",
          ...entry,
        },
      ],
      has_more: false,
      first_id: id,
      last_id: id,
    };
  return { data: [{ id, object: "model", ...entry }] };
}

/** A request as sent: its address, headers, and JSON body. */
interface SentRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** A tool with a required and an optional field, as teammates' tools have. */
const lookup: Tool = {
  name: "lookup",
  description: "Look something up.",
  parameters: Type.Object({
    query: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
};

/** A conversation with a system prompt, history, and one tool. */
const conversation: Context = {
  systemPrompt: "Help.",
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  tools: [lookup],
};

/**
 * Send one request through the real discovery, capability, runtime, and Pi serializers for a model
 * that `provider`'s model list reports as `entry` under `id`, and return what reached the wire.
 */
async function send(
  provider: ProviderId,
  id: string,
  entry: object,
  { effort, baseUrl }: { effort?: InferenceEffort; baseUrl?: string } = {},
) {
  const sent: SentRequest[] = [];
  const address = baseUrl ?? "http://models.test/v1";
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/models") || url.includes("/v1/models?"))
      return Response.json(modelList(provider, id, entry));
    sent.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return reply(provider, id);
  };
  const access = {
    /** Each provider's credential shape, with fake values. */
    async access() {
      return provider === "chatgpt"
        ? {
            credential: { accessToken: "oauth-owner" },
            baseUrl: null,
            model: null,
          }
        : provider === "anthropic"
          ? { credential: { apiKey: "claude-key" }, baseUrl: null, model: null }
          : {
              credential: { apiKey: "local-key" },
              baseUrl: address,
              model: null,
            };
    },
  };
  const capabilities = new PiModelCapabilities();
  const models = new ProviderModelService(
    access,
    new HttpModelDiscovery(fetcher),
    capabilities,
  );
  const [listed] = await models.list("owner", provider);
  const runtime = await new PiInferenceRuntimeFactory(
    access,
    models,
    capabilities,
    fetcher,
  ).create("owner", {
    provider,
    model: id,
    effort: effort ?? listed!.defaultEffort,
  });
  const chosen = effort ?? listed!.defaultEffort;
  await runtime.models.completeSimple(
    runtime.model,
    conversation,
    chosen === "off" ? {} : { reasoning: chosen },
  );
  assert.equal(sent.length, 1);
  return { listed: listed!, runtime, request: sent[0]! };
}

/** A request without its model identity and SDK-generated per-request headers. */
function identityFree(provider: ProviderId, request: SentRequest) {
  const { model: _model, ...body } = request.body;
  const {
    "x-stainless-retry-count": _retry,
    "x-stainless-timeout": _timeout,
    ...headers
  } = request.headers;
  return { provider, url: request.url, headers, body };
}

/** Rich metadata each provider's model list can report for one model. */
const reported: Readonly<Record<ProviderId, object>> = {
  chatgpt: {
    display_name: "Fixture",
    context_window: 300_000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: ["low", "medium", "high"].map((effort) => ({
      effort,
      description: effort,
    })),
    default_reasoning_level: "medium",
    service_tiers: [{ id: "priority", name: "Fast", description: "Fast" }],
  },
  anthropic: {
    max_input_tokens: 500_000,
    max_tokens: 64_000,
    capabilities: {
      image_input: { supported: true },
      thinking: {
        supported: true,
        types: { adaptive: { supported: true }, enabled: { supported: false } },
      },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: null,
        max: { supported: false },
      },
    },
  },
  "openai-compatible": {
    context_length: 65_536,
    top_provider: { max_completion_tokens: 8192 },
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
  },
};

/**
 * For each provider: a model Pi's bundled catalog knows, a new model it doesn't, and a near-miss of
 * the known ID, such as a dated snapshot.
 */
const identities: Readonly<Record<ProviderId, readonly string[]>> = {
  chatgpt: ["gpt-6.1-sol", "gpt-next-fixture", "gpt-6.1-sol-2026-11-18"],
  anthropic: ["claude-opus-5-5", "claude-next-fixture", "claude-opus-5-5-mini"],
  "openai-compatible": [
    "o3-mini",
    "fixture/next-model",
    "qwen3.8-flash-next-unsloth-ud-iq4_xs",
  ],
};

const providers = ["chatgpt", "anthropic", "openai-compatible"] as const;

// ===========================================
// Identity never decides capability
// ===========================================

test("each provider offers and sends the same settings for known, new, and near-miss model IDs reporting the same metadata", async () => {
  for (const provider of providers)
    for (const entry of [reported[provider], {}]) {
      const results = await Promise.all(
        identities[provider].map((id) => send(provider, id, entry)),
      );
      const [reference] = results;
      for (const [index, result] of results.entries()) {
        const id = identities[provider][index]!;
        assert.equal(result.request.body.model, id);
        assert.deepEqual(
          { ...result.listed, id: "", name: "" },
          { ...reference!.listed, id: "", name: "" },
          `${provider} ${id}`,
        );
        assert.deepEqual(
          { ...result.runtime.info, model: "" },
          { ...reference!.runtime.info, model: "" },
          `${provider} ${id}`,
        );
        assert.deepEqual(
          identityFree(provider, result.request),
          identityFree(provider, reference!.request),
          `${provider} ${id}`,
        );
      }
    }
});

test("the same model ID is offered and sent differently only when its model list reports different capabilities", async () => {
  const rich = await send("chatgpt", "gpt-6.1-sol", reported.chatgpt, {
    effort: "high",
  });
  const bare = await send("chatgpt", "gpt-6.1-sol", {});
  assert.deepEqual(
    [rich.listed.efforts, rich.listed.effortSource, rich.listed.speeds],
    [["low", "medium", "high"], "provider", ["standard", "fast"]],
  );
  assert.deepEqual(
    [bare.listed.efforts, bare.listed.effortSource, bare.listed.speeds],
    [["off"], "unknown", ["standard"]],
  );
  assert.deepEqual(rich.request.body.reasoning, {
    effort: "high",
    summary: "auto",
  });
  assert.equal(bare.request.body.reasoning, undefined);
  assert.deepEqual(
    [rich.runtime.info, bare.runtime.info].map((info) => [
      info?.contextWindow,
      info?.contextSource,
      info?.imageInput,
      info?.imageSource,
    ]),
    [
      [300_000, "provider", true, "provider"],
      [200_000, "fallback", null, "unknown"],
    ],
  );
  // Both send tools with strict: false and their declared required fields.
  for (const { request } of [rich, bare])
    assert.deepEqual(
      (request.body.tools as Record<string, unknown>[]).map(
        ({ strict, parameters }) => [
          strict,
          (parameters as { required?: string[] }).required,
        ],
      ),
      [[false, ["query"]]],
    );
});

test("an internal request's minimal effort is left out on ChatGPT where the model doesn't list it, rather than sent as the nearest level", async () => {
  for (const [levels, expected] of [
    [["low", "medium", "high"], undefined],
    [["none", "low"], { effort: "none" }],
    [["minimal", "low"], { effort: "minimal", summary: "auto" }],
  ] as const) {
    const { runtime } = await send("chatgpt", "gpt-next-fixture", {
      supported_reasoning_levels: levels.map((effort) => ({
        effort,
        description: effort,
      })),
    });
    const bodies: Record<string, unknown>[] = [];
    await runtime.models.completeSimple(runtime.model, conversation, {
      reasoning: "minimal",
      maxTokens: 128,
      onPayload: (payload) => {
        bodies.push(payload as Record<string, unknown>);
        return undefined;
      },
    });
    // Without a listed minimal, only the model's own listed off value, if any, is sent.
    assert.deepEqual(bodies[0]!.reasoning, expected, levels.join(","));
  }
});

// ===========================================
// Pi registration
// ===========================================

test("a runtime's model is exactly the discovered descriptor, with nothing inherited from Pi's bundled catalog row of the same ID", async () => {
  const { runtime } = await send("chatgpt", "gpt-6.1-sol", {});
  const model = runtime.model as unknown as Record<string, unknown>;
  assert.deepEqual(model.compat, { supportsStrictMode: true });
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(model.input, ["text"]);
  assert.deepEqual(model.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  for (const field of ["inputLimits", "promptCache", "samplingParams"])
    assert.equal(model[field], undefined, field);
  const claude = (await send("anthropic", "claude-opus-5-5", {})).runtime
    .model as unknown as Record<string, unknown>;
  assert.deepEqual(claude.compat, { forceAdaptiveThinking: true });
  assert.equal(claude.reasoning, false);
});

test("compatible requests are the same on any server address for model IDs that look like another provider's", async () => {
  for (const baseUrl of [
    "http://models.test/v1",
    "https://openrouter.ai/api/v1",
  ]) {
    const [first, second] = await Promise.all(
      ["anthropic/claude-fixture", "fixture/model"].map((id) =>
        send("openai-compatible", id, reported["openai-compatible"], {
          baseUrl,
        }),
      ),
    );
    assert.deepEqual(
      identityFree("openai-compatible", first!.request),
      identityFree("openai-compatible", second!.request),
      baseUrl,
    );
    // No effort contract: no reasoning field, and the system prompt keeps the system role.
    assert.equal(first!.request.body.reasoning_effort, undefined);
    assert.equal(
      (first!.request.body.messages as { role: string }[])[0]!.role,
      "system",
    );
  }
});
