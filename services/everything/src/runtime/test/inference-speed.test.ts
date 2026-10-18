import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProviderId } from "@everything/provider-contracts";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import { speedReport } from "../model/speed-report.js";

/** One outgoing provider request as the transport sent it. */
interface SentRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

/** Encode provider events as a server-sent event response for the native SDKs. */
function stream(events: { type: string; [key: string]: unknown }[]): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A completed Responses stream whose terminal response reports `tier`, or no tier when undefined. */
function responses(
  tier: string | undefined,
  created: Record<string, unknown> = {},
): Response {
  return stream([
    { type: "response.created", response: { id: "response", ...created } },
    {
      type: "response.completed",
      response: {
        id: "response",
        status: "completed",
        output: [],
        ...(tier !== undefined ? { service_tier: tier } : {}),
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]);
}

/** A completed Messages stream whose usage reports `speed`, or no speed when undefined. */
function messages(model: string, speed: string | undefined): Response {
  return stream([
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
        usage: {
          input_tokens: 2,
          output_tokens: 0,
          ...(speed !== undefined ? { speed } : {}),
        },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

/** A runtime for one owner's selection whose provider answers through `respond`, recording requests. */
async function runtime(
  selection: InferenceSelection,
  respond: (request: SentRequest) => Response,
) {
  const sent: SentRequest[] = [];
  const factory = new PiInferenceRuntimeFactory(
    {
      /** Give each provider the credential shape its real connection stores. */
      async access(_ownerId, provider: ProviderId) {
        return provider === "chatgpt"
          ? {
              credential: { accessToken: "oauth-owner" },
              baseUrl: null,
              model: null,
            }
          : {
              credential: { apiKey: "claude-key" },
              baseUrl: "https://api.anthropic.com/v1",
              model: null,
            };
      },
    },
    {
      /** Speed validation is covered by the provider-model tests. */
      async select(_ownerId, choice) {
        return { id: choice.model, name: choice.model };
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (input, init) => {
      const request = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      sent.push(request);
      return respond(request);
    },
  );
  const { models, model } = await factory.create("owner", selection);
  /** Complete one request at the selected effort, with any caller stream options. */
  const complete = (
    options: Parameters<typeof models.completeSimple>[2] = {},
  ): Promise<AssistantMessage> =>
    models.completeSimple(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { reasoning: "high", ...options },
    );
  return { sent, complete };
}

/** A request body without its speed field, for comparing everything else a request sends. */
function withoutSpeed(body: Record<string, unknown>): Record<string, unknown> {
  const { service_tier: _tier, speed: _speed, ...rest } = body;
  return rest;
}

/** The beta features a Messages request asked for. */
function betas(headers: Headers): string[] {
  return (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean)
    .sort();
}

// ===========================================
// ChatGPT sign-in: OpenAI Responses
// ===========================================

test("ChatGPT Fast adds the priority service tier to the sent Responses body, keeping model, effort, OAuth, and streaming", async () => {
  const base = {
    provider: "chatgpt",
    model: "gpt-6.1-sol",
    effort: "high",
  } as const;
  const bodies: Record<string, unknown>[] = [];
  for (const selection of [
    base,
    { ...base, speed: "standard" },
    { ...base, speed: "fast" },
  ] satisfies InferenceSelection[]) {
    const { sent, complete } = await runtime(selection, () =>
      responses("default"),
    );
    await complete();
    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.equal(request!.url, "https://api.openai.com/v1/responses");
    assert.equal(request!.headers.get("authorization"), "Bearer oauth-owner");
    assert.equal(request!.body.model, "gpt-6.1-sol");
    assert.equal(request!.body.store, false);
    assert.equal(request!.body.stream, true);
    assert.equal(
      (request!.body.reasoning as { effort: string }).effort,
      "high",
    );
    bodies.push(request!.body);
  }
  const [legacy, standard, fast] = bodies;
  assert.ok(!("service_tier" in legacy!));
  assert.ok(!("service_tier" in standard!));
  assert.equal(fast!.service_tier, "priority");
  assert.deepEqual(withoutSpeed(fast!), legacy);
  assert.deepEqual(standard, legacy);
});

test("ChatGPT effective speed comes only from the terminal response, keeping the raw tier and reporting downgrades", async () => {
  const fast = {
    provider: "chatgpt",
    model: "gpt-6.1-sol",
    effort: "high",
    speed: "fast",
  } as const;
  for (const [tier, effective] of [
    ["priority", "fast"],
    ["fast", "fast"],
    ["default", "standard"],
    ["flex", "unknown"],
    [undefined, "unknown"],
  ] as const) {
    const { complete } = await runtime(fast, () => responses(tier));
    const message = await complete();
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(speedReport(message), {
      requested: "fast",
      effective,
      ...(tier !== undefined ? { reportedTier: tier } : {}),
    });
  }
  // The created event only echoes the request; it is not the tier that served the response.
  const { complete } = await runtime(fast, () =>
    responses(undefined, { service_tier: "priority" }),
  );
  assert.deepEqual(speedReport(await complete()), {
    requested: "fast",
    effective: "unknown",
  });
});

test("each request on a shared runtime asks for Fast and keeps its own reported speed", async () => {
  const tiers = ["priority", "default"];
  const { sent, complete } = await runtime(
    {
      provider: "chatgpt",
      model: "gpt-6.1-sol",
      effort: "high",
      speed: "fast",
    },
    () => responses(tiers.shift()),
  );
  const [first, second] = [await complete(), await complete()];
  assert.deepEqual(
    sent.map((request) => request.body.service_tier),
    ["priority", "priority"],
  );
  assert.deepEqual(
    [speedReport(first)?.effective, speedReport(second)?.effective],
    ["fast", "standard"],
  );
});

test("ChatGPT requests without Fast still record a provider-reported Fast tier", async () => {
  const { sent, complete } = await runtime(
    { provider: "chatgpt", model: "gpt-6.1-sol", effort: "high" },
    () => responses("priority"),
  );
  assert.deepEqual(speedReport(await complete()), {
    requested: "standard",
    effective: "fast",
    reportedTier: "priority",
  });
  assert.ok(!("service_tier" in sent[0]!.body));
});

test("ChatGPT Fast keeps the caller's asynchronous payload hook result and stream-event hook", async () => {
  const seen: string[] = [];
  const { sent, complete } = await runtime(
    {
      provider: "chatgpt",
      model: "gpt-6.1-sol",
      effort: "high",
      speed: "fast",
    },
    () => responses("priority"),
  );
  const message = await complete({
    async onPayload(payload) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { ...(payload as Record<string, unknown>), caller_field: "kept" };
    },
    onProviderStreamEvent(event) {
      seen.push((event as { type: string }).type);
    },
  });
  assert.equal(sent[0]!.body.caller_field, "kept");
  assert.equal(sent[0]!.body.service_tier, "priority");
  assert.deepEqual(seen, ["response.created", "response.completed"]);
  assert.equal(speedReport(message)?.effective, "fast");
});

test("ChatGPT plan refusals of the service tier are recorded before or after the stream opens, sent once, with unknown speed", async () => {
  const fast = {
    provider: "chatgpt",
    model: "gpt-6.1-sol",
    effort: "high",
    speed: "fast",
  } as const;
  const refusal = {
    message: "Service tier override is not supported for this plan.",
    type: "invalid_request_error",
    param: "service_tier",
    code: "subscription_sharing_unsupported_capability",
  };
  for (const [respond, failure] of [
    [() => Response.json({ error: refusal }, { status: 400 }), "rejected"],
    // A failed response after HTTP 200 reaches Pi's event hook.
    [
      () =>
        stream([
          { type: "response.created", response: { id: "response" } },
          {
            type: "response.failed",
            response: { id: "response", status: "failed", error: refusal },
          },
        ]),
      "rejected",
    ],
    // The OpenAI SDK raises a named error event before Pi's hook, so it keeps the ordinary failure.
    [
      () =>
        stream([
          { type: "response.created", response: { id: "response" } },
          { ...refusal, type: "error", sequence_number: 1 },
        ]),
      undefined,
    ],
  ] as const) {
    const { sent, complete } = await runtime(fast, respond);
    const message = await complete();
    assert.equal(message.stopReason, "error");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.body.service_tier, "priority");
    assert.deepEqual(speedReport(message), {
      requested: "fast",
      effective: "unknown",
      ...(failure ? { failure } : {}),
    });
  }
});

test("ChatGPT failures unrelated to the service tier keep their ordinary handling", async () => {
  const fast = {
    provider: "chatgpt",
    model: "gpt-6.1-sol",
    effort: "high",
    speed: "fast",
  } as const;
  for (const respond of [
    () =>
      Response.json(
        {
          error: {
            message: "Unsupported input.",
            param: "input",
            code: "subscription_sharing_unsupported_capability",
          },
        },
        { status: 400 },
      ),
    () =>
      Response.json(
        {
          error: {
            message: "Usage limit reached.",
            code: "subscription_sharing_usage_limit_exceeded",
          },
        },
        { status: 429 },
      ),
    () =>
      stream([
        { type: "response.created", response: { id: "response" } },
        {
          type: "response.failed",
          response: {
            id: "response",
            status: "failed",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "Usage limit reached.",
            },
          },
        },
      ]),
  ]) {
    const { sent, complete } = await runtime(fast, respond);
    const message = await complete();
    assert.equal(message.stopReason, "error");
    assert.equal(sent.length, 1);
    assert.deepEqual(speedReport(message), {
      requested: "fast",
      effective: "unknown",
    });
  }
});

// ===========================================
// Anthropic Messages
// ===========================================

test("Claude Opus 5.5 Fast sends speed without the preview beta, keeping Pi's betas, model, effort, and key", async () => {
  const base = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
  } as const;
  const requests: SentRequest[] = [];
  for (const selection of [
    base,
    { ...base, speed: "fast" },
  ] satisfies InferenceSelection[]) {
    const { sent, complete } = await runtime(selection, () =>
      messages("claude-opus-5-5", "fast"),
    );
    await complete();
    assert.equal(sent.length, 1);
    requests.push(sent[0]!);
  }
  const [standard, fast] = requests;
  for (const request of requests) {
    assert.equal(new URL(request.url).pathname, "/v1/messages");
    assert.equal(request.headers.get("x-api-key"), "claude-key");
    assert.equal(request.body.model, "claude-opus-5-5");
  }
  assert.ok(!("speed" in standard!.body));
  assert.equal(fast!.body.speed, "fast");
  assert.deepEqual(withoutSpeed(fast!.body), standard!.body);
  assert.ok(betas(standard!.headers).length > 0);
  assert.deepEqual(betas(fast!.headers), betas(standard!.headers));
  assert.ok(!betas(fast!.headers).includes("fast-mode-2026-02-01"));
});

test("Claude research-preview Fast models add the fast-mode beta to the betas Pi already sends", async () => {
  for (const model of ["claude-opus-5", "claude-opus-4-8"]) {
    const base = { provider: "anthropic", model, effort: "high" } as const;
    const [standard, fast] = await Promise.all(
      ([base, { ...base, speed: "fast" }] satisfies InferenceSelection[]).map(
        async (selection) => {
          const { sent, complete } = await runtime(selection, () =>
            messages(model, "fast"),
          );
          await complete();
          return sent[0]!;
        },
      ),
    );
    assert.equal(fast!.body.speed, "fast");
    assert.deepEqual(withoutSpeed(fast!.body), withoutSpeed(standard!.body));
    assert.deepEqual(
      betas(fast!.headers),
      [...betas(standard!.headers), "fast-mode-2026-02-01"].sort(),
    );
  }
});

test("Claude effective speed comes from message usage, including downgrades and requests without Fast", async () => {
  const base = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
  } as const;
  for (const [selection, speed, report] of [
    [
      { ...base, speed: "fast" },
      "fast",
      { requested: "fast", effective: "fast", reportedTier: "fast" },
    ],
    [
      { ...base, speed: "fast" },
      "standard",
      { requested: "fast", effective: "standard", reportedTier: "standard" },
    ],
    [
      { ...base, speed: "fast" },
      undefined,
      { requested: "fast", effective: "unknown" },
    ],
    [
      base,
      "fast",
      { requested: "standard", effective: "fast", reportedTier: "fast" },
    ],
  ] as const) {
    const { complete } = await runtime(selection, () =>
      messages("claude-opus-5-5", speed),
    );
    assert.deepEqual(speedReport(await complete()), report);
  }
});

test("Claude refusals that name Fast mode are recorded once; other Claude errors keep their ordinary handling", async () => {
  const fast = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
    speed: "fast",
  } as const;
  /** An Anthropic error response. */
  const failure = (status: number, type: string, message: string) => () =>
    Response.json({ type: "error", error: { type, message } }, { status });
  for (const [respond, expected] of [
    [
      failure(
        400,
        "invalid_request_error",
        "speed: fast mode is not available for this organization",
      ),
      "rejected",
    ],
    [
      failure(
        429,
        "rate_limit_error",
        "Fast mode output tokens per minute limit exceeded",
      ),
      "limited",
    ],
    [
      failure(
        429,
        "rate_limit_error",
        "Number of request tokens has exceeded your per-minute rate limit",
      ),
      undefined,
    ],
    [
      failure(400, "invalid_request_error", "max_tokens: must be at least 1"),
      undefined,
    ],
  ] as const) {
    const { sent, complete } = await runtime(fast, respond);
    const message = await complete();
    assert.equal(message.stopReason, "error");
    assert.equal(sent.length, 1);
    assert.deepEqual(speedReport(message), {
      requested: "fast",
      effective: "unknown",
      ...(expected ? { failure: expected } : {}),
    });
  }
});

// ===========================================
// Other providers
// ===========================================

test("OpenAI-compatible servers receive no speed field and record no speed", async () => {
  const sent: Record<string, unknown>[] = [];
  const factory = new PiInferenceRuntimeFactory(
    {
      /** A keyless local server. */
      async access() {
        return {
          credential: {},
          baseUrl: "http://local.test/v1",
          model: "local",
        };
      },
    },
    {
      /** Validation is covered elsewhere. */
      async select(_ownerId, choice) {
        return { id: choice.model, name: choice.model };
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return stream([
        {
          type: "chunk",
          id: "chunk",
          object: "chat.completion.chunk",
          created: 1,
          model: "local",
          choices: [
            { index: 0, delta: { content: "Hi" }, finish_reason: "stop" },
          ],
        },
      ]);
    },
  );
  const { models, model } = await factory.create("owner", {
    provider: "openai-compatible",
    model: "local",
    effort: "off",
  });
  const message = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  });
  assert.equal(sent.length, 1);
  assert.ok(!("service_tier" in sent[0]!) && !("speed" in sent[0]!));
  assert.equal(speedReport(message), undefined);
});
