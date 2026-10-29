import assert from "node:assert/strict";
import { test } from "node:test";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { PiInferenceRuntimeFactory } from "../../runtime/adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../../runtime/adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../../runtime/factory/model-runtime.js";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import { classifyModelFailure } from "../service/model-failure-classifier.js";
import {
  PromptDiagnostics,
  withPromptDiagnostics,
} from "../service/prompt-diagnostics.js";
import { failure, settled, sse, teammate } from "./runtime-fixtures.js";
import {
  eventsNamed,
  exportedText,
  spansNamed,
  startInMemoryTelemetry,
} from "./telemetry-fixtures.js";

const telemetry = startInMemoryTelemetry();

/** The generic text owners see; provider details must never replace it. */
const genericFailure =
  "Your teammate couldn’t finish replying. Check the model provider, then send a message to continue.";

test("a provider error before the stream is recorded with its safe cause, request ID, and the turn's trace", async (context) => {
  telemetry.reset();
  const { runtime, definition } = await teammate(context, () =>
    failure(
      400,
      {
        error: {
          message:
            "Invalid request: api_key=sk-live-abcdef1234567890 was rejected; retry at https://model.test/v1/chat?token=hunter2secret",
          type: "invalid_request_error",
          code: "invalid_parameter",
        },
      },
      { "x-request-id": "req_invalid_400" },
    ),
  );
  runtime.start("Hello");
  await settled(runtime);
  assert.equal(runtime.status.error, genericFailure);
  const exported = await telemetry.collect();

  const [model] = eventsNamed(exported, telemetryEvents.modelFailed);
  assert.ok(model, "the model failure is recorded");
  assert.equal(model.severityText, "ERROR");
  assert.equal(model.attributes[attribute.ownerId], "owner-a");
  assert.equal(model.attributes[attribute.agentId], definition.id);
  assert.equal(model.attributes[attribute.provider], "openai-compatible");
  assert.equal(model.attributes[attribute.model], "o3-mini");
  assert.equal(model.attributes[attribute.sessionKind], "main");
  assert.ok(model.attributes[attribute.runId]);
  assert.equal(model.attributes[attribute.category], "invalid_request");
  assert.equal(model.attributes[attribute.code], "invalid_parameter");
  assert.equal(model.attributes[attribute.httpStatus], 400);
  assert.equal(model.attributes[attribute.requestId], "req_invalid_400");
  assert.equal(model.attributes[attribute.retryable], false);
  assert.equal(model.attributes[attribute.attempts], 1);
  assert.equal(
    model.attributes[attribute.message],
    undefined,
    "the provider's error text is withheld, as this process is set to",
  );
  assert.equal(model.attributes[attribute.textWithheld], true);
  assert.doesNotMatch(
    exportedText(exported),
    /Invalid request|sk-live-abcdef1234567890|hunter2secret|sk-test-owner-key/,
  );

  const [turn] = spansNamed(exported, telemetrySpans.turn);
  const [prompt] = spansNamed(exported, telemetrySpans.prompt);
  const [request] = spansNamed(exported, telemetrySpans.providerRequest);
  assert.ok(turn && prompt && request);
  const traceId = turn.spanContext().traceId;
  assert.equal(
    prompt.spanContext().traceId,
    traceId,
    "the prompt joins the turn's trace",
  );
  assert.equal(prompt.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(
    request.spanContext().traceId,
    traceId,
    "the provider request joins it too",
  );
  assert.equal(request.parentSpanContext?.spanId, prompt.spanContext().spanId);
  assert.equal(request.attributes[attribute.httpStatus], 400);
  assert.equal(request.attributes[attribute.ownerId], "owner-a");
  assert.equal(request.status.code, SpanStatusCode.ERROR);
  assert.equal(request.status.message, "HTTP 400");
  assert.equal(request.attributes[attribute.code], "invalid_parameter");
  assert.equal(request.attributes[attribute.textWithheld], true);
  assert.equal(prompt.status.message, "Model request failed: invalid_request");
  assert.equal(
    model.spanContext?.traceId,
    traceId,
    "the event is correlated with the trace",
  );
  assert.equal(turn.status.code, SpanStatusCode.ERROR);

  const [turnFailed] = eventsNamed(exported, telemetryEvents.turnFailed);
  assert.equal(turnFailed?.attributes[attribute.code], "MODEL_REQUEST_FAILED");
  assert.equal(turnFailed?.spanContext?.traceId, traceId);
});

test("a rate-limited turn records its category, Retry-After, and the provider's request ID", async (context) => {
  telemetry.reset();
  const { runtime } = await teammate(context, () =>
    failure(
      429,
      {
        error: {
          message: "Rate limit reached for requests",
          type: "rate_limit_exceeded",
        },
      },
      { "retry-after": "17", "x-request-id": "req_limited" },
    ),
  );
  runtime.start("Hello");
  await settled(runtime);
  const exported = await telemetry.collect();
  const [model] = eventsNamed(exported, telemetryEvents.modelFailed);
  assert.equal(model?.attributes[attribute.category], "rate_limit");
  assert.equal(model?.attributes[attribute.retryable], true);
  assert.equal(model?.attributes[attribute.retryAfter], "17");
  assert.equal(model?.attributes[attribute.requestId], "req_limited");
  assert.equal(model?.attributes[attribute.attempts], 1);
});

test("retries within one model request are numbered attempts that keep the last response", async () => {
  telemetry.reset();
  let calls = 0;
  const factory = new PiInferenceRuntimeFactory(
    {
      /** A keyed compatible server. */
      async access() {
        return {
          baseUrl: "http://model.test/v1",
          credential: { apiKey: "sk-test-retry-key-0123" },
          model: null,
        };
      },
    },
    {
      /** Model policy is covered by the provider tests. */
      async select(_ownerId, selection) {
        return { id: selection.model, name: selection.model };
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
    async () =>
      failure(
        503,
        {
          error: {
            message: "Service temporarily unavailable",
            type: "server_error",
          },
        },
        { "retry-after-ms": "1", "x-request-id": `req_retry_${++calls}` },
      ),
  );
  const { models, model } = await factory.create("owner-a", {
    provider: "openai-compatible",
    model: "o3-mini",
    effort: "high",
  });
  const diagnostics = new PromptDiagnostics();
  const response = await context.with(withPromptDiagnostics(diagnostics), () =>
    models.completeSimple(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { maxRetries: 2 },
    ),
  );
  assert.equal(response.stopReason, "error");
  assert.equal(diagnostics.attempts, 3);
  assert.equal(diagnostics.lastResponse?.status, 503);
  assert.equal(diagnostics.lastResponse?.requestId, "req_retry_3");
  assert.equal(diagnostics.lastResponse?.errorType, "server_error");
  const exported = await telemetry.collect();
  const requests = spansNamed(exported, telemetrySpans.providerRequest);
  assert.deepEqual(
    requests.map((span) => span.attributes[attribute.attempt]),
    [1, 2, 3],
  );
  assert.ok(
    requests.every((span) => span.attributes[attribute.ownerId] === "owner-a"),
  );
});

/**
 * Run one model request whose SDK retries once, answering each HTTP attempt from `attempts` in
 * turn, and return the prompt's diagnostics and the request's diagnosis.
 */
async function retriedRequest(
  attempts: readonly (() => Response | Promise<Response>)[],
) {
  let calls = 0;
  const factory = new PiInferenceRuntimeFactory(
    {
      /** A keyed compatible server. */
      async access() {
        return {
          baseUrl: "http://model.test/v1",
          credential: { apiKey: "sk-test-retry-key-0123" },
          model: null,
        };
      },
    },
    {
      /** Model policy is covered by the provider tests. */
      async select(_ownerId, selection) {
        return { id: selection.model, name: selection.model };
      },
    },
    new PiModelCapabilities(await createModelRuntime()),
    async () => attempts[calls++]!(),
  );
  const { models, model } = await factory.create("owner-a", {
    provider: "openai-compatible",
    model: "o3-mini",
    effort: "high",
  });
  const diagnostics = new PromptDiagnostics();
  const response = await context.with(withPromptDiagnostics(diagnostics), () =>
    models.completeSimple(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { maxRetries: attempts.length - 1 },
    ),
  );
  assert.equal(calls, attempts.length, "every attempt was made");
  assert.equal(response.stopReason, "error");
  return {
    diagnostics,
    failure: classifyModelFailure({
      stopReason: "error",
      ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
      ...(diagnostics.lastResponse
        ? { lastResponse: diagnostics.lastResponse }
        : {}),
    }),
  };
}

/** A transport failure before any response, as `fetch` reports a refused connection. */
function refused(): never {
  throw new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    }),
  });
}

for (const [status, body] of [
  [429, { error: { message: "Rate limited", type: "rate_limit_error" } }],
  [503, { error: { message: "Unavailable", type: "server_error" } }],
] as const)
  test(`a network failure after a retried ${status} is diagnosed from the final attempt, not the ${status}`, async () => {
    telemetry.reset();
    const { diagnostics, failure: diagnosis } = await retriedRequest([
      () =>
        failure(status, body, {
          "retry-after-ms": "1",
          "x-request-id": `req_attempt_1_${status}`,
        }),
      refused,
    ]);
    assert.equal(diagnostics.attempts, 2);
    assert.equal(
      diagnostics.lastResponse,
      undefined,
      "the final attempt received no response",
    );
    assert.equal(diagnosis.category, "network");
    assert.equal(diagnosis.retryable, true);
    assert.equal(diagnosis.httpStatus, undefined);
    assert.equal(diagnosis.code, undefined);
    assert.equal(diagnosis.requestId, undefined);
    const exported = await telemetry.collect();
    // The first attempt's span ends once its error body has been read, which can be later.
    const [first, second] = [1, 2].map((attempt) =>
      spansNamed(exported, telemetrySpans.providerRequest).find(
        (span) => span.attributes[attribute.attempt] === attempt,
      ),
    );
    assert.equal(
      first?.attributes[attribute.httpStatus],
      status,
      "the first attempt's span keeps its response",
    );
    assert.equal(
      first?.attributes[attribute.requestId],
      `req_attempt_1_${status}`,
    );
    assert.equal(second?.attributes[attribute.httpStatus], undefined);
    assert.equal(second?.status.code, SpanStatusCode.ERROR);
  });

test("a stream that fails after a retried 503 keeps the final attempt's successful response", async () => {
  telemetry.reset();
  const { diagnostics, failure: diagnosis } = await retriedRequest([
    () =>
      failure(
        503,
        { error: { message: "Unavailable", type: "server_error" } },
        { "retry-after-ms": "1", "x-request-id": "req_unavailable" },
      ),
    () =>
      sse([
        {
          error: {
            message: "The server is overloaded, please retry",
            type: "overloaded_error",
          },
        },
      ]),
  ]);
  assert.equal(diagnostics.lastResponse?.attempt, 2);
  assert.equal(diagnosis.httpStatus, 200);
  assert.equal(diagnosis.requestId, "req_stream_ok");
  assert.equal(diagnosis.category, "overloaded");
});

test("a response read after a later attempt or request began never replaces its diagnosis", () => {
  const diagnostics = new PromptDiagnostics();
  const latest = () => diagnostics.lastResponse;
  diagnostics.beginRequest();
  const first = diagnostics.nextAttempt();
  const second = diagnostics.nextAttempt();
  diagnostics.record(first, { attempt: 1, status: 429, requestId: "req_1" });
  assert.equal(latest(), undefined);
  diagnostics.record(second, { attempt: 2, status: 200 });
  assert.equal(latest()?.attempt, 2);
  diagnostics.beginRequest();
  const next = diagnostics.nextAttempt();
  diagnostics.record(second, { attempt: 2, status: 503 });
  assert.equal(latest(), undefined, "a previous request's");
  diagnostics.record(next, { attempt: 1, status: 200 });
  assert.equal(latest()?.status, 200);
});

test("a stream that fails after a successful response is still diagnosed", async (context) => {
  telemetry.reset();
  const { runtime } = await teammate(context, () =>
    sse([
      {
        id: "completion",
        object: "chat.completion.chunk",
        created: 1,
        model: "o3-mini",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Partial" },
            finish_reason: null,
          },
        ],
      },
      {
        error: {
          message: "The server is overloaded, please retry",
          type: "overloaded_error",
        },
      },
    ]),
  );
  runtime.start("Hello");
  await settled(runtime);
  assert.equal(runtime.status.error, genericFailure);
  const exported = await telemetry.collect();
  const [model] = eventsNamed(exported, telemetryEvents.modelFailed);
  assert.ok(model, "the stream failure is recorded");
  assert.equal(model.attributes[attribute.category], "overloaded");
  assert.equal(model.attributes[attribute.httpStatus], 200);
  assert.equal(model.attributes[attribute.retryable], true);
  assert.equal(model.attributes[attribute.requestId], "req_stream_ok");
  assert.equal(model.attributes[attribute.textWithheld], true);
  assert.doesNotMatch(exportedText(exported), /please retry/);
});

test("stopping a turn records a cancellation, not a failure", async (context) => {
  telemetry.reset();
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { runtime } = await teammate(context, ({ signal }) => {
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
  runtime.start("Hello");
  await requested;
  await runtime.stop();
  const exported = await telemetry.collect();
  assert.equal(eventsNamed(exported, telemetryEvents.modelFailed).length, 0);
  assert.equal(eventsNamed(exported, telemetryEvents.turnFailed).length, 0);
  const [cancelled] = eventsNamed(exported, telemetryEvents.turnCancelled);
  assert.equal(cancelled?.attributes[attribute.reason], "stopped");
  assert.equal(cancelled?.attributes[attribute.severity], "info");
  const [turn] = spansNamed(exported, telemetrySpans.turn);
  assert.equal(turn?.attributes[attribute.outcome], "cancelled");
  assert.notEqual(turn?.status.code, SpanStatusCode.ERROR);
  const [model] = eventsNamed(exported, telemetryEvents.modelCancelled);
  assert.equal(model?.attributes[attribute.category], "cancelled");
});
