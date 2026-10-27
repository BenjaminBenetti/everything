import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { InferenceEffort } from "@everything/provider-contracts/inference";
import { HttpModelDiscovery } from "../../provider/adapter/http-model-discovery.js";
import { ProviderModelService } from "../../provider/service/provider-models.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../factory/model-runtime.js";

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

/**
 * Model listing, validation, and inference for one Claude model whose model list reports
 * `reported` capabilities, over fake credentials and an intercepting transport.
 */
async function claude(id: string, reported: unknown) {
  const messages: Record<string, unknown>[] = [];
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
          },
        ],
        has_more: false,
        first_id: id,
        last_id: id,
      });
    assert.equal(url.pathname, "/v1/messages");
    messages.push(JSON.parse(String(init?.body)));
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
  const [listed] = await models.list("owner", "anthropic");
  return {
    listed: listed!,
    models,
    messages,
    /** Send one turn at `effort` after an earlier reply that Pi's managed mode recorded at max. */
    async send(effort: InferenceEffort): Promise<Record<string, unknown>> {
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
        effort === "off" ? {} : { reasoning: effort },
      );
      return messages.at(-1)!;
    },
  };
}

/** Every effort a Messages request carries: at the root and in each message. */
function sentEfforts(body: Record<string, unknown>): string[] {
  const efforts = [body, ...(body.messages as Record<string, unknown>[])]
    .map(
      (item) => (item.output_config as { effort?: string } | undefined)?.effort,
    )
    .filter((effort) => effort !== undefined);
  return efforts as string[];
}

// ===========================================
// Managed-effort models
// ===========================================

test("a managed-effort Claude model reported low-only sends only low, at the root and in no replayed history", async () => {
  const model = await claude("claude-opus-5-5", capabilities({ low: true }));
  assert.deepEqual(
    [model.listed.effortSource, model.listed.efforts],
    ["provider", ["low"]],
  );
  for (const effort of model.listed.efforts) {
    const body = await model.send(effort);
    assert.deepEqual(sentEfforts(body), ["low"], effort);
    assert.deepEqual(body.output_config, { effort: "low" });
    assert.deepEqual(body.thinking, {
      type: "adaptive",
      display: "summarized",
    });
  }
});

test("a managed-effort Claude model reporting every level keeps Pi's managed history and fixed root", async () => {
  const model = await claude("claude-opus-5-5", capabilities(allLevels));
  assert.deepEqual(model.listed.efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const body = await model.send("low");
  // Root high, the earlier reply's level, then the chosen level: all reported as accepted.
  assert.deepEqual(sentEfforts(body), ["high", "max", "low"]);
});

test("a managed-effort Claude model accepting no reported level is sent no thinking or effort", async () => {
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
    const body = await model.send("off");
    assert.deepEqual(sentEfforts(body), []);
    assert.equal(body.thinking, undefined);
  }
});

// ===========================================
// Adaptive and token-budget catalog models
// ===========================================

test("an adaptive Claude model whose effort is withdrawn stops offering and sending effort levels", async () => {
  for (const reported of [
    capabilities(allLevels, { effort: false }),
    capabilities(allLevels, { adaptive: false }),
  ]) {
    const model = await claude("claude-opus-4-8", reported);
    assert.deepEqual(
      [model.listed.effortSource, model.listed.efforts],
      ["provider", ["off"]],
    );
    const body = await model.send("off");
    assert.deepEqual(sentEfforts(body), []);
    assert.equal(body.thinking, undefined);
  }
});

test("an adaptive Claude model reported low-only never sends a higher effort", async () => {
  const model = await claude("claude-opus-4-8", capabilities({ low: true }));
  // Off keeps the catalog's support: Anthropic's effort capability does not cover it.
  assert.deepEqual(model.listed.efforts, ["off", "minimal", "low"]);
  for (const effort of model.listed.efforts)
    assert.deepEqual(
      sentEfforts(await model.send(effort)),
      effort === "off" ? [] : ["low"],
      effort,
    );
});

test("token-budget Claude models keep their budget thinking whatever effort the provider reports", async () => {
  const model = await claude(
    "claude-sonnet-4-5",
    capabilities(allLevels, { effort: false, adaptive: false }),
  );
  assert.deepEqual(
    [model.listed.effortSource, model.listed.efforts],
    ["catalog", ["off", "minimal", "low", "medium", "high"]],
  );
  const body = await model.send("high");
  assert.deepEqual(sentEfforts(body), []);
  assert.equal((body.thinking as { type: string }).type, "enabled");
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
