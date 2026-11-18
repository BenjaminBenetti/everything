import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { InferenceEffort } from "@everything/provider-contracts/inference";
import { HttpModelDiscovery } from "../../provider/adapter/http-model-discovery.js";
import { ProviderModelService } from "../../provider/service/provider-models.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";

// ===========================================
// Fixtures
// ===========================================

/** An Anthropic capability flag. */
const support = (supported: boolean) => ({ supported });

/** Claude capabilities with the given effort flags and adaptive thinking support. */
function capabilities(
  levels: Partial<Record<"low" | "medium" | "high" | "xhigh" | "max", boolean>>,
  { effort = true, adaptive = true } = {},
): unknown {
  return {
    effort: {
      supported: effort,
      low: support(levels.low ?? false),
      medium: support(levels.medium ?? false),
      high: support(levels.high ?? false),
      xhigh: support(levels.xhigh ?? false),
      max: support(levels.max ?? false),
    },
    thinking: {
      supported: true,
      types: { adaptive: support(adaptive), enabled: support(!adaptive) },
    },
  };
}

/** Every Anthropic effort level supported, as the documented Opus 5.5 example reports. */
const allLevels = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} as const;

/** An SSE response completing one empty Claude reply. */
function reply(model: string): Response {
  return new Response(
    [
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
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** One Messages request as sent: its JSON body and its beta header. */
interface SentMessage {
  readonly body: Record<string, unknown>;
  readonly betas: string[];
}

/**
 * Model listing, validation, and inference for one Claude model whose model list reports
 * `reported` capabilities and the given limits, over fake credentials and an intercepting transport.
 */
async function claude(
  id: string,
  reported: unknown,
  limits: { max_input_tokens?: number; max_tokens?: number } = {},
) {
  const messages: SentMessage[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.anthropic.com");
    assert.equal(
      new Headers(init?.headers).get("x-api-key"),
      "test-claude-key",
    );
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [
          {
            id,
            display_name: id,
            type: "model",
            created_at: "2026-01-01",
            capabilities: reported,
            ...limits,
          },
        ],
        has_more: false,
        first_id: id,
        last_id: id,
      });
    assert.equal(url.pathname, "/v1/messages");
    messages.push({
      body: JSON.parse(String(init?.body)),
      betas: (new Headers(init?.headers).get("anthropic-beta") ?? "")
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean),
    });
    return reply(id);
  };
  const access = {
    /** One owner's Claude connection, with a fake key. */
    async access() {
      return {
        credential: { apiKey: "test-claude-key" },
        baseUrl: "https://api.anthropic.com/v1",
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
  const runtimes = new PiInferenceRuntimeFactory(
    access,
    models,
    capabilities,
    fetcher,
  );
  const [listed] = await models.list("owner", "anthropic");
  return {
    listed: listed!,
    models,
    messages,
    /** Send one turn at `effort` after an earlier reply that Pi's managed mode recorded at max. */
    async send(
      effort: InferenceEffort,
      options: { reasoning?: "minimal"; maxTokens?: number } = {},
    ): Promise<SentMessage> {
      const runtime = await runtimes.create("owner", {
        provider: "anthropic",
        model: id,
        effort,
      });
      const earlier: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Earlier reply" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: id,
        providerThinkingLevel: "max",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      };
      const history: Message[] = [
        { role: "user", content: "Earlier question", timestamp: 1 },
        earlier,
        { role: "user", content: "Hello", timestamp: 3 },
      ];
      await runtime.models.completeSimple(
        runtime.model,
        { messages: history },
        { ...(effort === "off" ? {} : { reasoning: effort }), ...options },
      );
      return messages.at(-1)!;
    },
  };
}

/** Every effort a Messages request carries: at the root and in each message. */
function sentEfforts({ body }: SentMessage): string[] {
  const efforts = [body, ...(body.messages as Record<string, unknown>[])]
    .map(
      (item) => (item.output_config as { effort?: string } | undefined)?.effort,
    )
    .filter((effort) => effort !== undefined);
  return efforts as string[];
}

/** A request with its model identity removed, to compare two models' requests. */
function withoutModel({ body, betas }: SentMessage) {
  const { model: _model, ...rest } = body;
  return { body: rest, betas };
}

// ===========================================
// Reported effort levels
// ===========================================

test("a Claude model is offered and sent the same effort whatever its ID, when its model list reports the same capabilities", async () => {
  const known = await claude("claude-opus-5-5", capabilities(allLevels));
  const novel = await claude("claude-next-test", capabilities(allLevels));
  assert.deepEqual(
    { ...known.listed, id: "", name: "" },
    { ...novel.listed, id: "", name: "" },
  );
  assert.deepEqual(known.listed.efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  for (const effort of known.listed.efforts) {
    const sent = await known.send(effort);
    assert.deepEqual(
      withoutModel(sent),
      withoutModel(await novel.send(effort)),
    );
    assert.equal(sent.body.model, "claude-opus-5-5");
    // Only the chosen level, at the root: earlier replies' levels are not replayed.
    assert.deepEqual(sentEfforts(sent), [effort]);
    assert.deepEqual(sent.body.thinking, {
      type: "adaptive",
      display: "summarized",
    });
    // No managed-effort, interleaved-thinking, or other beta is sent.
    assert.deepEqual(sent.betas, []);
  }
});

test("a Claude model reported low-only offers and sends only low", async () => {
  const model = await claude("claude-opus-5-5", capabilities({ low: true }));
  assert.deepEqual(
    [model.listed.effortSource, model.listed.efforts],
    ["provider", ["low"]],
  );
  assert.deepEqual(sentEfforts(await model.send("low")), ["low"]);
  for (const effort of ["off", "minimal", "medium", "high"] as const)
    await assert.rejects(
      model.models.validate("owner", {
        provider: "anthropic",
        model: "claude-opus-5-5",
        effort,
      }),
      { code: "INFERENCE_SELECTION_INVALID" },
      effort,
    );
});

test("a Claude model accepting no reported level is sent no thinking or effort, and says the provider reported that", async () => {
  for (const reported of [
    capabilities({}),
    capabilities(allLevels, { effort: false }),
    capabilities(allLevels, { adaptive: false }),
  ]) {
    const model = await claude("claude-opus-5-5", reported);
    assert.deepEqual(
      [model.listed.effortSource, model.listed.efforts],
      ["provider", ["off"]],
    );
    const sent = await model.send("off");
    assert.deepEqual(sentEfforts(sent), []);
    assert.equal(sent.body.thinking, undefined);
  }
});

test("a Claude model with no reported capabilities offers only the provider's default, sending no thinking or effort", async () => {
  for (const reported of [null, {}, { thinking: "yes" }]) {
    const model = await claude("claude-opus-5-5", reported);
    assert.deepEqual(
      [model.listed.effortSource, model.listed.efforts],
      ["unknown", ["off"]],
    );
    const sent = await model.send("off");
    assert.deepEqual(sentEfforts(sent), []);
    assert.equal(sent.body.thinking, undefined);
  }
});

// ===========================================
// Response room
// ===========================================

test("a Claude request's max_tokens is the model list's reported cap, or a quarter of its context when it reports none", async () => {
  const reported = await claude("claude-next-test", capabilities(allLevels), {
    max_input_tokens: 400_000,
    max_tokens: 64_000,
  });
  assert.equal((await reported.send("high")).body.max_tokens, 64_000);
  const contextOnly = await claude(
    "claude-next-test",
    capabilities(allLevels),
    {
      max_input_tokens: 100_000,
    },
  );
  assert.equal((await contextOnly.send("high")).body.max_tokens, 25_000);
  const unknown = await claude("claude-next-test", null);
  assert.equal((await unknown.send("off")).body.max_tokens, 4096);
});

test("an internal request's minimal effort is left out where the model doesn't report it, without raising its output cap", async () => {
  for (const reported of [capabilities({ medium: true }), null]) {
    const model = await claude("claude-next-test", reported);
    const effort = model.listed.efforts[0]!;
    // A background summary asks for minimal effort with a small cap.
    const sent = await model.send(effort, {
      reasoning: "minimal",
      maxTokens: 128,
    });
    assert.deepEqual(sentEfforts(sent), []);
    assert.equal(sent.body.thinking, undefined);
    assert.equal(sent.body.max_tokens, 128);
  }
});

// ===========================================
// Saved selections
// ===========================================

test("a saved effort the provider no longer accepts is refused before any request, and is not replaced", async () => {
  const model = await claude(
    "claude-opus-4-8",
    capabilities(allLevels, { effort: false }),
  );
  const saved = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: "medium",
  } as const;
  await assert.rejects(model.models.validate("owner", saved), {
    code: "INFERENCE_SELECTION_INVALID",
  });
  await assert.rejects(model.send("medium"), {
    code: "INFERENCE_SELECTION_INVALID",
  });
  assert.equal(model.messages.length, 0);
  // Choosing an offered effort repairs the teammate.
  await model.models.validate("owner", { ...saved, effort: "off" });
  assert.deepEqual(sentEfforts(await model.send("off")), []);
});
