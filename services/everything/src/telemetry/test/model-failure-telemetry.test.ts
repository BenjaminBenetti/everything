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
  const message = String(model.attributes[attribute.message]);
  assert.match(message, /Invalid request/);
  assert.doesNotMatch(
    exportedText(exported),
    /sk-live-abcdef1234567890|hunter2secret|sk-test-owner-key/,
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
  assert.match(String(model.attributes[attribute.message]), /overloaded/i);
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
