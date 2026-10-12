import assert from "node:assert/strict";
import { test } from "node:test";
import type { InferenceSelection } from "@everything/provider-contracts/inference";
import { PiInferenceRuntimeFactory } from "../adapter/pi-inference-runtime.js";
import { PiModelCapabilities } from "../adapter/pi-model-capabilities.js";
import { createModelRuntime } from "../factory/model-runtime.js";

/** Encode provider events as a completed SSE response for the native SDKs. */
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

test("ChatGPT uses owner-specific OAuth with the public Responses protocol and selected effort", async () => {
  const requests: { body: Record<string, unknown>; token: string | null }[] =
    [];
  const factory = new PiInferenceRuntimeFactory(
    {
      /** Give simultaneous owners distinct credentials for the same provider. */
      async access(ownerId, provider) {
        assert.equal(provider, "chatgpt");
        return {
          credential: { accessToken: `oauth-${ownerId}` },
          baseUrl: null,
          model: "o3-mini",
        };
      },
    },
    {
      /** Selection validation is exercised by provider-model tests. */
      async validate() {},
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/responses");
      requests.push({
        body: JSON.parse(String(init?.body)),
        token: new Headers(init?.headers).get("authorization"),
      });
      return stream([
        { type: "response.created", response: { id: "response" } },
        {
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
        },
      ]);
    },
  );
  const selection: InferenceSelection = {
    provider: "chatgpt",
    model: "o3-mini",
    effort: "high",
  };
  const first = await factory.create("first", selection);
  const second = await factory.create("second", selection);
  const messages = [{ role: "user" as const, content: "Hello", timestamp: 1 }];
  await first.models.completeSimple(
    first.model,
    { messages },
    { reasoning: "high", maxTokens: 4096 },
  );
  await second.models.completeSimple(
    second.model,
    { messages },
    { reasoning: "low", maxTokens: 4096 },
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((item) => item.token),
    ["Bearer oauth-first", "Bearer oauth-second"],
  );
  for (const { body } of requests) {
    assert.equal(body.model, "o3-mini");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.ok(Array.isArray(body.input));
    assert.equal(body.max_output_tokens, undefined);
  }
  assert.equal(
    (requests[0]!.body.reasoning as { effort: string }).effort,
    "high",
  );
  assert.equal(
    (requests[1]!.body.reasoning as { effort: string }).effort,
    "low",
  );
});

test("Claude uses the official messages endpoint and maps selected effort through Pi", async () => {
  const requests: Record<string, unknown>[] = [];
  const factory = new PiInferenceRuntimeFactory(
    {
      /** The connection stores a versioned API address; the SDK appends its own versioned path. */
      async access() {
        return {
          credential: { apiKey: "test-claude-key" },
          baseUrl: "https://api.anthropic.com/v1",
          model: "claude-sonnet-4-6",
        };
      },
    },
    {
      /** Runtime behavior is independent from separately tested availability validation. */
      async validate() {},
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (input, init) => {
      assert.equal(new URL(String(input)).pathname, "/v1/messages");
      assert.equal(new URL(String(input)).origin, "https://api.anthropic.com");
      assert.equal(
        new Headers(init?.headers).get("x-api-key"),
        "test-claude-key",
      );
      requests.push(JSON.parse(String(init?.body)));
      return stream([
        {
          type: "message_start",
          message: {
            id: "message",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
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
      ]);
    },
  );
  const runtime = await factory.create("owner", {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    effort: "high",
  });
  await runtime.models.completeSimple(
    runtime.model,
    { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
    { reasoning: "high" },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.model, "claude-sonnet-4-6");
  assert.deepEqual(requests[0]!.thinking, {
    type: "adaptive",
    display: "summarized",
  });
  assert.deepEqual(requests[0]!.output_config, { effort: "high" });
});

test("local Qwen effort choices reach the compatible API and Default leaves the server setting intact", async () => {
  const id = "qwen3.8-flash-next-unsloth-ud-iq4_xs";
  const requests: Record<string, unknown>[] = [];
  const factory = new PiInferenceRuntimeFactory(
    {
      /** Supply the configured alias exactly as advertised by the local server. */
      async access() {
        return {
          credential: { apiKey: "owner-key" },
          baseUrl: "http://local.test/v1",
          model: id,
        };
      },
    },
    {
      /** The provider API regression covers validation of each supported effort. */
      async validate() {},
    },
    new PiModelCapabilities(await createModelRuntime()),
    async (input, init) => {
      assert.equal(String(input), "http://local.test/v1/chat/completions");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer owner-key",
      );
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        `data: ${JSON.stringify({
          id: "completion",
          object: "chat.completion.chunk",
          created: 1,
          model: id,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Done" },
              finish_reason: "stop",
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  for (const effort of ["low", "medium", "xhigh", "off"] as const) {
    const runtime = await factory.create("owner", {
      provider: "openai-compatible",
      model: id,
      effort,
    });
    const reply = await runtime.models.completeSimple(
      runtime.model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      effort === "off" ? {} : { reasoning: effort },
    );
    assert.equal(reply.stopReason, "stop");
    assert.equal(requests.at(-1)!.model, id);
    assert.equal(
      requests.at(-1)!.reasoning_effort,
      effort === "off" ? undefined : effort,
    );
  }
  assert.equal(requests.length, 4);
});
