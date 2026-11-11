import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ProviderId } from "@everything/provider-contracts";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession as PiSession,
} from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../adapter/pi-agent-session.js";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../factory/model-runtime.js";
import type { ModelRetryPolicy } from "../model/model-retry-policy.js";
import { sendMessageTool } from "../tool/send-message-tool.js";
import { classifyModelFailure } from "../../telemetry/service/model-failure-classifier.js";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
  telemetrySpans,
} from "../../telemetry/model/telemetry-attributes.js";
import {
  eventsNamed,
  spansNamed,
  startInMemoryTelemetry,
} from "../../telemetry/test/telemetry-fixtures.js";

const telemetry = startInMemoryTelemetry();

/** The production policy's attempts, without its waits. */
const quick: ModelRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 2,
};

/** A ChatGPT sign-in teammate on the model the reported failures came from. */
const chatgpt: InferenceSelection = {
  provider: "chatgpt",
  model: "gpt-6.1-sol",
  effort: "high",
};

/** One request the provider received: its number, JSON body, and abort signal. */
interface Call {
  readonly number: number;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}

// ===========================================
// Provider responses
// ===========================================

/** Server-sent events as the provider SDKs read them, ending after the last one given. */
function events(list: { type: string; [key: string]: unknown }[]): Response {
  return new Response(
    list
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req_stream",
      },
    },
  );
}

const created = { type: "response.created", response: { id: "response" } };

/** A Responses message item at `index` that has streamed `text`, finished when `done`. */
function textItem(text: string, done = true, index = 0) {
  const id = `message_${index}`;
  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: {
        type: "message",
        id,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: index,
      content_index: 0,
      item_id: id,
      delta: text,
    },
    ...(done
      ? [
          {
            type: "response.output_item.done",
            output_index: index,
            item: {
              type: "message",
              id,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          },
        ]
      : []),
  ];
}

/** A Responses function call at `index` whose arguments have streamed as `json`, finished when `done`. */
function callItem(name: string, json: string, done = true, index = 0) {
  const id = `function_${index}`;
  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: {
        type: "function_call",
        id,
        call_id: `call_${index}`,
        name,
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: index,
      item_id: id,
      delta: json,
    },
    ...(done
      ? [
          {
            type: "response.output_item.done",
            output_index: index,
            item: {
              type: "function_call",
              id,
              call_id: `call_${index}`,
              name,
              arguments: json,
              status: "completed",
            },
          },
        ]
      : []),
  ];
}

const completed = {
  type: "response.completed",
  response: {
    id: "response",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  },
};

/** A complete Responses reply with `text`. */
const replied = (text: string) =>
  events([created, ...textItem(text), completed]);

/** A complete Responses reply that calls send_message with `text`. */
const sends = (text: string) =>
  events([
    created,
    ...callItem("send_message", JSON.stringify({ text })),
    completed,
  ]);

/** A stream that ends, after HTTP 200 and some text, before its terminal event. */
const cutText = () => events([created, ...textItem("Partial answ", false)]);

/** A stream that ends partway through a send_message call's arguments, before its terminal event. */
const cutCall = () =>
  events([created, ...callItem("send_message", '{"text":"Half a mess', false)]);

/** A JSON error response. */
const failure = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A complete Anthropic Messages reply with `text`. */
function anthropicReply(text: string): Response {
  return events([
    {
      type: "message_start",
      message: {
        id: "message",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

// ===========================================
// A teammate's session
// ===========================================

/**
 * A real Pi session for `selection`, wrapped as Everything runs it with `policy` (none: `null`),
 * whose provider answers each request through `respond`. Its only tool is the real send_message,
 * whose deliveries are counted.
 */
async function teammate(
  context: TestContext,
  selection: InferenceSelection,
  respond: (call: Call) => Response | Promise<Response>,
  policy: ModelRetryPolicy | null = quick,
) {
  const calls: Call[] = [];
  const inference = new PiInferenceRuntimeFactory(
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
      /** Model policy is covered by the provider tests. */
      async select(_ownerId, choice) {
        return { id: choice.model, name: choice.model };
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (_input, init) => {
      const call = {
        number: calls.length + 1,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        signal: init?.signal ?? undefined,
      };
      calls.push(call);
      return respond(call);
    },
  );
  const { models, model } = await inference.create("owner-a", selection);
  const cwd = await mkdtemp(path.join(tmpdir(), "everything-retry-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = path.join(cwd, ".pi");
  // As the session factory opens sessions: Pi's own retry and compaction off.
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Help the user.",
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const delivered: string[] = [];
  const tool = sendMessageTool(async (text) => {
    delivered.push(text);
  });
  const { session: pi } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    tools: [tool.name],
    customTools: [tool],
  });
  context.after(() => pi.dispose());
  const session = new PiAgentSession(
    pi,
    Date.now,
    {
      ownerId: "owner-a",
      agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
      sessionKind: "main",
      provider: selection.provider,
      model: selection.model,
    },
    policy ?? undefined,
  );
  return { session, pi, calls, delivered };
}

/** Answer request `n` (from 1) with `responses[n - 1]`. */
const inTurn =
  (...responses: (() => Response)[]) =>
  ({ number }: Call) =>
    responses[number - 1]!();

/** What the model was sent as the conversation so far, for comparing requests. */
const input = (call: Call | undefined) => JSON.stringify(call?.body.input);

/** The conversation the session will send next, by role, after its system prompt. */
const roles = (pi: PiSession) =>
  pi.messages
    .map((message) => message.role)
    .filter((role) => role !== "system");

/** The responses that failed, which Pi keeps in the session's raw history. */
function failedResponses(pi: PiSession) {
  return pi.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error"
        ? [entry.message]
        : [],
    );
}

// ===========================================
// Retried failures
// ===========================================

test("a Responses stream that ends after HTTP 200 without its terminal event is sent again, and only the reply is kept", async (context) => {
  const { session, pi, calls } = await teammate(
    context,
    chatgpt,
    inTurn(cutText, () => replied("All done.")),
  );
  await session.prompt("Summarize the plan");
  assert.equal(calls.length, 2, "one retry");
  assert.equal(
    input(calls[1]),
    input(calls[0]),
    "the retry sends the same conversation",
  );
  assert.equal(
    input(calls[1]).match(/Summarize the plan/g)?.length,
    1,
    "with the prompt once",
  );
  assert.doesNotMatch(
    input(calls[1]),
    /Partial answ/,
    "and nothing of the failed response",
  );
  assert.deepEqual(roles(pi), ["user", "assistant"]);
  assert.equal(session.lastResponse, "All done.");
  const [failed] = failedResponses(pi);
  assert.match(
    failed?.errorMessage ?? "",
    /ended before a terminal response event/,
  );
  const diagnosis = classifyModelFailure({
    stopReason: "error",
    errorMessage: failed!.errorMessage!,
  });
  assert.equal(diagnosis.category, "stream_interrupted");
  assert.equal(diagnosis.retryable, true);
});

test("a request is sent at most three times, with bounded waits, and only its last failure reaches the caller", async (context) => {
  const { session, pi, calls } = await teammate(context, chatgpt, cutText, {
    maxRetries: 2,
    baseDelayMs: 3,
    maxDelayMs: 5,
  });
  const scheduled: { attempt: number; delayMs: number }[] = [];
  pi.subscribe((event) => {
    if (event.type === "auto_retry_start")
      scheduled.push({ attempt: event.attempt, delayMs: event.delayMs });
  });
  await assert.rejects(session.prompt("Summarize the plan"), {
    message: "Pi model request failed",
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(scheduled, [
    { attempt: 1, delayMs: 3 },
    { attempt: 2, delayMs: 5 },
  ]);
  assert.equal(
    failedResponses(pi).length,
    3,
    "each attempt stays in the raw history",
  );
  assert.deepEqual(
    roles(pi),
    ["user", "assistant"],
    "the model is sent only the last",
  );
  assert.equal(
    pi.settingsManager.getRetrySettings().enabled,
    false,
    "Pi's own retry is off again",
  );
});

for (const [name, respond] of [
  [
    "a ChatGPT user temporarily unavailable (503)",
    () =>
      failure(503, {
        error: {
          message: "ChatGPT user is temporarily unavailable",
          code: "subscription_sharing_user_unavailable",
        },
      }),
  ],
  [
    "an overloaded provider",
    () =>
      failure(529, {
        error: { message: "Overloaded", type: "overloaded_error" },
      }),
  ],
  [
    "a Cloudflare 520",
    () =>
      new Response("<html><body>error code: 520</body></html>", {
        status: 520,
        headers: { "content-type": "text/html" },
      }),
  ],
  [
    "an ordinary rate limit (429)",
    () =>
      failure(429, {
        error: { message: "Rate limit reached", type: "rate_limit_error" },
      }),
  ],
  [
    "a request that times out",
    () => {
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    },
  ],
] as const)
  test(`${name} is sent again`, async (context) => {
    const { session, calls } = await teammate(
      context,
      chatgpt,
      inTurn(respond, () => replied("Recovered.")),
    );
    await session.prompt("Hello");
    assert.equal(calls.length, 2);
    assert.equal(session.lastResponse, "Recovered.");
  });

for (const [name, respond] of [
  [
    "a refused credential (401)",
    () =>
      failure(401, {
        error: {
          message: "Invalid token",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
  ],
  [
    "an invalid request (400)",
    () =>
      failure(400, {
        error: {
          message: "Unsupported parameter",
          type: "invalid_request_error",
        },
      }),
  ],
  [
    "a ChatGPT usage limit (429)",
    () =>
      failure(429, {
        error: {
          message: "Usage limit reached.",
          code: "subscription_sharing_usage_limit_exceeded",
        },
      }),
  ],
  [
    "an exhausted quota (429)",
    () =>
      failure(429, {
        error: {
          message: "You exceeded your current quota",
          type: "insufficient_quota",
        },
      }),
  ],
] as const)
  test(`${name} fails at once`, async (context) => {
    const { session, calls } = await teammate(
      context,
      chatgpt,
      inTurn(respond, () => replied("Unexpected.")),
    );
    await assert.rejects(session.prompt("Hello"), {
      message: "Pi model request failed",
    });
    assert.equal(calls.length, 1);
  });

// ===========================================
// Fast mode
// ===========================================

test("a Fast mode limit fails at once with its own recovery, while an ordinary rate limit on a Fast request is retried", async (context) => {
  const fast: InferenceSelection = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
    speed: "fast",
  };
  const limited = () =>
    failure(429, {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Fast mode output tokens per minute limit exceeded",
      },
    });
  const fastLimit = await teammate(
    context,
    fast,
    inTurn(limited, () => anthropicReply("Unexpected.")),
  );
  await assert.rejects(fastLimit.session.prompt("Hello"), {
    code: "FAST_MODE_LIMITED",
  });
  assert.equal(fastLimit.calls.length, 1, "never retried");

  const ordinary = () =>
    failure(429, {
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "Number of request tokens has exceeded your per-minute rate limit",
      },
    });
  const rateLimit = await teammate(
    context,
    fast,
    inTurn(ordinary, () => anthropicReply("Recovered.")),
  );
  await rateLimit.session.prompt("Hello");
  assert.equal(rateLimit.calls.length, 2);
  assert.equal(rateLimit.calls[1]!.body.speed, "fast", "still at Fast speed");
  assert.equal(rateLimit.session.lastResponse, "Recovered.");
});

test("a refused Fast request fails at once with its own recovery", async (context) => {
  const refused = () =>
    failure(400, {
      error: {
        message: "Service tier override is not supported for this plan.",
        type: "invalid_request_error",
        param: "service_tier",
        code: "subscription_sharing_unsupported_capability",
      },
    });
  const { session, calls } = await teammate(
    context,
    { ...chatgpt, speed: "fast" },
    inTurn(refused, () => replied("Unexpected.")),
  );
  await assert.rejects(session.prompt("Hello"), { code: "FAST_MODE_REJECTED" });
  assert.equal(calls.length, 1);
});

// ===========================================
// Tools and history
// ===========================================

test("a failure after a completed tool round resends only the failed request: the tool does not run again", async (context) => {
  const { session, pi, calls, delivered } = await teammate(
    context,
    chatgpt,
    inTurn(
      () => sends("Here is the plan."),
      cutText,
      () => replied("Done."),
    ),
  );
  await session.prompt("Send me the plan");
  assert.deepEqual(
    delivered,
    ["Here is the plan."],
    "the message was delivered once",
  );
  assert.equal(calls.length, 3);
  assert.equal(
    input(calls[2]),
    input(calls[1]),
    "the retry sends what the failed request did",
  );
  assert.match(
    input(calls[2]),
    /function_call_output/,
    "including the tool's result",
  );
  assert.equal(
    input(calls[2]).match(/Send me the plan/g)?.length,
    1,
    "and the prompt once",
  );
  assert.deepEqual(roles(pi), ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(session.lastResponse, "Done.");
  assert.equal(session.lastToolName, "send_message");
});

test("a tool call cut off by a failed stream never runs; the retry's complete call runs once", async (context) => {
  const { session, pi, calls, delivered } = await teammate(
    context,
    chatgpt,
    inTurn(
      cutCall,
      () => sends("A whole message."),
      () => replied("Done."),
    ),
  );
  await session.prompt("Tell me something");
  assert.deepEqual(delivered, ["A whole message."]);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(
    input(calls[1]),
    /Half a mess|function_call/,
    "the cut-off call is never sent back",
  );
  assert.deepEqual(roles(pi), ["user", "assistant", "toolResult", "assistant"]);
  const [failed] = failedResponses(pi);
  assert.ok(
    Array.isArray(failed?.content) &&
      failed.content.some((block) => block.type === "toolCall"),
    "the failed response did stream part of a call",
  );
});

test("an exhausted request after a tool round leaves the tool's result and one prompt in the history", async (context) => {
  const { session, pi, calls, delivered } = await teammate(
    context,
    chatgpt,
    ({ number }) => (number === 1 ? sends("Here is the plan.") : cutText()),
  );
  await assert.rejects(session.prompt("Send me the plan"), {
    message: "Pi model request failed",
  });
  assert.equal(calls.length, 4, "the tool round and three attempts after it");
  assert.deepEqual(delivered, ["Here is the plan."]);
  assert.deepEqual(roles(pi), ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(
    pi.messages.filter((message) => message.role === "user").length,
    1,
  );
});

// ===========================================
// Stopping
// ===========================================

test("stopping during a stream ends the prompt as cancelled, sending nothing more", async (context) => {
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { session, calls } = await teammate(context, chatgpt, ({ signal }) => {
    started();
    return new Promise<Response>((_resolve, reject) =>
      signal?.addEventListener("abort", () =>
        reject(
          Object.assign(new Error("This operation was aborted"), {
            name: "AbortError",
          }),
        ),
      ),
    );
  });
  const prompt = session.prompt("Hello");
  await requested;
  await session.abort();
  await prompt;
  assert.equal(calls.length, 1);
});

test("stopping while a retry waits ends the wait at once, sending nothing more", async (context) => {
  const { session, pi, calls } = await teammate(
    context,
    chatgpt,
    inTurn(cutText, () => replied("Unexpected.")),
    {
      maxRetries: 2,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
    },
  );
  let waiting!: () => void;
  const scheduled = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  pi.subscribe((event) => {
    if (event.type === "auto_retry_start") waiting();
  });
  const started = Date.now();
  const prompt = session.prompt("Hello");
  await scheduled;
  await session.abort();
  await prompt;
  assert.ok(Date.now() - started < 10_000, "the minute-long wait did not run");
  assert.equal(calls.length, 1);
  assert.equal(pi.settingsManager.getRetrySettings().enabled, false);
});

test("without a policy, a failed request is not sent again", async (context) => {
  const { session, calls } = await teammate(
    context,
    chatgpt,
    inTurn(cutText, () => replied("Unexpected.")),
    null,
  );
  await assert.rejects(session.prompt("Hello"), {
    message: "Pi model request failed",
  });
  assert.equal(calls.length, 1);
});

// ===========================================
// Telemetry
// ===========================================

/** The model failures and prompt spans exported for `session` alone. */
async function recorded(session: PiAgentSession) {
  const exported = await telemetry.collect();
  const ours = (attributes: Record<string, unknown> | undefined) =>
    attributes?.[attribute.sessionId] === session.id;
  return {
    failures: eventsNamed(exported, telemetryEvents.modelFailed).filter(
      (event) => ours(event.attributes),
    ),
    prompts: spansNamed(exported, telemetrySpans.prompt).filter((span) =>
      ours(span.attributes),
    ),
  };
}

test("each failed attempt is recorded with its number; a request that recovers leaves its prompt successful", async (context) => {
  telemetry.reset();
  const { session } = await teammate(
    context,
    chatgpt,
    inTurn(cutText, cutText, () => replied("Recovered.")),
  );
  await session.prompt("Hello");
  const { failures, prompts } = await recorded(session);
  assert.deepEqual(
    failures.map((event) => [
      event.attributes[attribute.attempt],
      event.attributes[attribute.willRetry],
      event.severityText,
      event.attributes[attribute.category],
      event.attributes[attribute.retryable],
      event.attributes[attribute.httpStatus],
    ]),
    [
      [1, true, "WARNING", "stream_interrupted", true, 200],
      [2, true, "WARNING", "stream_interrupted", true, 200],
    ],
  );
  const [prompt] = prompts;
  assert.ok(prompt);
  assert.notEqual(
    prompt.status.code,
    SpanStatusCode.ERROR,
    "the prompt succeeded",
  );
  assert.deepEqual(
    prompt?.events
      .filter((event) => event.name === "retry.scheduled")
      .map((event) => event.attributes?.[attribute.attempt]),
    [1, 2],
  );
});

test("an exhausted request records its last attempt as the failure", async (context) => {
  telemetry.reset();
  const { session } = await teammate(context, chatgpt, cutText);
  await assert.rejects(session.prompt("Hello"));
  const { failures, prompts } = await recorded(session);
  assert.deepEqual(
    failures.map((event) => [
      event.attributes[attribute.attempt],
      event.attributes[attribute.willRetry],
      event.severityText,
    ]),
    [
      [1, true, "WARNING"],
      [2, true, "WARNING"],
      [3, false, "ERROR"],
    ],
  );
  const [prompt] = prompts;
  assert.equal(prompt?.status.code, SpanStatusCode.ERROR);
  assert.equal(
    prompt?.status.message,
    "Model request failed: stream_interrupted",
  );
});

// ===========================================
// Stopped requests that end as errors
// ===========================================

/**
 * A scripted Pi session whose one response fails with `errorMessage`, after `abort()` when
 * `stopFirst`, recorded under its own ID.
 */
function scriptedFailure(errorMessage: string, stopFirst: boolean) {
  let listener: Parameters<PiSession["subscribe"]>[0] | undefined;
  let stopped!: () => void;
  const stop = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const failed = {
    role: "assistant",
    api: "openai-responses",
    stopReason: "error",
    errorMessage,
    content: [],
  };
  const pi = {
    sessionId: `scripted-${Math.random()}`,
    isCompacting: false,
    messages: [] as unknown[],
    subscribe(next: typeof listener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      if (stopFirst) await stop;
      pi.messages.push(failed);
      listener?.({ type: "message_end", message: failed } as never);
    },
    async abort() {
      stopped();
    },
  };
  return new PiAgentSession(pi as unknown as PiSession, Date.now, {
    ownerId: "owner-a",
    agentId: "0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c",
    sessionKind: "main",
    provider: "chatgpt",
    model: "gpt-6.1-sol",
  });
}

test("a request the prompt's own stop aborted is a cancellation, even when it ends as an error", async () => {
  telemetry.reset();
  const session = scriptedFailure("This operation was aborted", true);
  const prompt = session.prompt("Hello");
  await session.abort();
  await prompt;
  const exported = await telemetry.collect();
  const ours = (attributes: Record<string, unknown> | undefined) =>
    attributes?.[attribute.sessionId] === session.id;
  assert.equal(
    eventsNamed(exported, telemetryEvents.modelFailed).filter((event) =>
      ours(event.attributes),
    ).length,
    0,
  );
  const [cancelled] = eventsNamed(
    exported,
    telemetryEvents.modelCancelled,
  ).filter((event) => ours(event.attributes));
  assert.equal(cancelled?.attributes[attribute.category], "cancelled");
  assert.equal(
    cancelled?.attributes[attribute.stopReason],
    "error",
    "what Pi reported is kept",
  );
});

test("abort wording without a stop, or another error after one, is still a failure", async () => {
  await assert.rejects(
    scriptedFailure("This operation was aborted", false).prompt("Hello"),
    {
      message: "Pi model request failed",
    },
  );
  const unrelated = scriptedFailure(
    'OpenAI API error (500): {"message":"Internal error"}',
    true,
  );
  const prompt = unrelated.prompt("Hello");
  await unrelated.abort();
  await assert.rejects(prompt, { message: "Pi model request failed" });
});
