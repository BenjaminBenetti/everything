import assert from "node:assert/strict";
import { test } from "node:test";
import { CompatibleConnectionVerifier } from "../adapter/compatible-connection-verifier.js";
import { AnthropicConnectionVerifier } from "../adapter/anthropic-connection-verifier.js";
import { ChatGptConnectionVerifier } from "../adapter/chatgpt-connection-verifier.js";

/** Emit provider-shaped JSON without a live account or billable request. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("compatible verification requires inference, uses the supplied address, and supports keyless models", async () => {
  const requests: string[] = [];
  const adapter = new CompatibleConnectionVerifier(async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (url.endsWith("/models"))
      return json({ data: [{ id: "embedding-model" }, { id: "local-chat" }] });
    assert.equal(url, "http://models.local:11434/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "local-chat");
    assert.equal(body.max_tokens, 1024);
    return json({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    });
  });
  assert.equal(
    await adapter.verify({
      credential: {},
      baseUrl: "http://models.local:11434/v1",
      model: null,
    }),
    "local-chat",
  );
  assert.equal(requests.length, 2);
});

test("an explicit compatible model works without a model-list endpoint and sends the saved key", async () => {
  const adapter = new CompatibleConnectionVerifier(async (input, init) => {
    assert.ok(String(input).endsWith("/chat/completions"));
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-key",
    );
    return json({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    });
  });
  assert.equal(
    await adapter.verify({
      credential: { apiKey: "test-key" },
      baseUrl: "https://example.test/v1",
      model: "chosen",
    }),
    "chosen",
  );
});

test("Claude verification checks the actual messages endpoint after authenticated discovery", async () => {
  const adapter = new AnthropicConnectionVerifier(async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.ok(
      headers.get("x-api-key") === "test-key" ||
        headers.get("authorization") === "Bearer test-key",
    );
    if (url.includes("/models"))
      return json({
        data: [{ id: "claude-sonnet" }, { id: "claude-haiku" }],
        has_more: false,
      });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "claude-haiku");
    return json({
      type: "message",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "OK" }],
    });
  });
  assert.equal(
    await adapter.verify({
      credential: { apiKey: "test-key" },
      baseUrl: null,
      model: null,
    }),
    "claude-haiku",
  );
});

test("provider HTTP failures explain the status and recovery without leaking response bodies", async () => {
  const cases: [number, RegExp][] = [
    [400, /rejected the test request.*request format/],
    [401, /credentials.*API key/],
    [402, /payment or credits.*billing/],
    [403, /denied access.*permission/],
    [404, /endpoint or model.*exact model name/],
    [405, /request method.*API base address/],
    [422, /rejected the test request.*request format/],
    [429, /rate or usage limit.*quota/],
    [503, /server error.*availability/],
  ];
  for (const [status, description] of cases) {
    const adapter = new CompatibleConnectionVerifier(async () =>
      json(
        { error: { message: "secret-key and private upstream details" } },
        status,
      ),
    );
    await assert.rejects(
      adapter.verify({
        credential: { apiKey: "secret-key" },
        baseUrl: "https://example.test/v1",
        model: "chosen",
      }),
      (error: Error) => {
        assert.ok(!error.message.includes("secret-key"));
        assert.ok(!error.message.includes("private upstream details"));
        assert.ok(error.message.includes(`HTTP ${status}`));
        assert.match(error.message, description);
        return true;
      },
    );
  }
});

test("compatible checks allow reasoning before requiring a visible answer", async () => {
  let requests = 0;
  const adapter = new CompatibleConnectionVerifier(async (_input, init) => {
    requests++;
    const budget = JSON.parse(String(init?.body)).max_tokens;
    assert.ok(budget <= 1024, "connection checks must stay bounded");
    // Model a server that spends its first 64 tokens on reasoning.
    return json({
      choices: [
        {
          message: {
            reasoning_content: "private reasoning",
            content: budget > 64 ? "OK" : null,
          },
          finish_reason: budget > 64 ? "stop" : "length",
        },
      ],
    });
  });
  assert.equal(
    await adapter.verify({
      credential: {},
      baseUrl: "http://models.local/v1",
      model: "reasoning-model",
    }),
    "reasoning-model",
  );
  assert.equal(requests, 1);
});

test("compatible response failures distinguish token exhaustion, empty answers, refusals, and invalid responses", async () => {
  const cases: { response: unknown; description: RegExp }[] = [
    {
      response: {
        choices: [
          {
            message: { content: null, reasoning_content: "private reasoning" },
            finish_reason: "length",
          },
        ],
      },
      description: /reasoning but no answer.*output limit.*1024/,
    },
    {
      response: {
        choices: [{ message: { content: null }, finish_reason: "length" }],
      },
      description: /no text.*output limit/,
    },
    {
      response: {
        choices: [
          {
            message: { content: null, reasoning: "private reasoning" },
            finish_reason: "stop",
          },
        ],
      },
      description: /reasoning but no text answer.*chat template/,
    },
    {
      response: {
        choices: [{ message: { content: "  " }, finish_reason: "stop" }],
      },
      description: /completed the request.*empty message/,
    },
    {
      response: {
        choices: [
          { message: { content: null }, finish_reason: "content_filter" },
        ],
      },
      description: /refused or filtered.*content settings/,
    },
    {
      response: {
        choices: [
          {
            message: { content: null, refusal: "private refusal" },
            finish_reason: "stop",
          },
        ],
      },
      description: /refused or filtered.*content settings/,
    },
    {
      response: {
        choices: [{ message: { content: null }, finish_reason: "tool_calls" }],
      },
      description: /requested a tool.*text chat/,
    },
    {
      response: {
        choices: [
          { message: { content: ["private content"] }, finish_reason: "stop" },
        ],
      },
      description: /unexpected format.*text answer/,
    },
    {
      response: {
        choices: [
          { message: { content: "OK" }, finish_reason: "private status" },
        ],
      },
      description: /without a supported completion status/,
    },
    {
      response: { choices: [] },
      description: /no chat message.*chat\/completions/,
    },
    { response: null, description: /no chat message.*chat\/completions/ },
  ];
  for (const { response, description } of cases) {
    const adapter = new CompatibleConnectionVerifier(async () =>
      json(response),
    );
    await assert.rejects(
      adapter.verify({
        credential: {},
        baseUrl: "http://models.local/v1",
        model: "chosen",
      }),
      (error: Error) => {
        assert.match(error.message, description);
        assert.ok(!error.message.includes("private"));
        return true;
      },
    );
  }
});

test("compatible discovery errors offer an explicit model as a recovery path", async () => {
  for (const response of [json({}, 404), json({ data: {} })]) {
    const adapter = new CompatibleConnectionVerifier(async () => response);
    await assert.rejects(
      adapter.verify({
        credential: {},
        baseUrl: "http://models.local/v1",
        model: null,
      }),
      /model.*API base address.*enter a model name under Advanced settings/,
    );
  }
});

test("compatible transport failures distinguish timeouts, connection failures, and invalid JSON", async () => {
  const cases: { fetcher: typeof fetch; description: RegExp }[] = [
    {
      fetcher: async () => {
        throw new DOMException("private details", "AbortError");
      },
      description: /did not finish the test response within 30 seconds/,
    },
    {
      fetcher: async () => {
        throw new TypeError("private details");
      },
      description: /could not connect.*reachable from Everything/,
    },
    {
      fetcher: async () =>
        new Response("invalid private JSON", {
          headers: { "content-type": "application/json" },
        }),
      description: /invalid JSON.*API base address/,
    },
  ];
  for (const { fetcher, description } of cases) {
    await assert.rejects(
      new CompatibleConnectionVerifier(fetcher).verify({
        credential: {},
        baseUrl: "http://models.local/v1",
        model: "chosen",
      }),
      (error: Error) => {
        assert.match(error.message, description);
        assert.ok(!error.message.includes("private"));
        return true;
      },
    );
  }
});

test("ChatGPT follows the plan-use request contract and requires a completed stream", async () => {
  for (const terminal of [
    "response.completed",
    "response.failed",
    "response.incomplete",
    "missing",
  ]) {
    const adapter = new ChatGptConnectionVerifier(async (input, init) => {
      const url = String(input);
      assert.ok(url.startsWith("https://api.openai.com/v1/"));
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer oauth-access",
      );
      if (url.endsWith("/models"))
        return json({
          models: [{ slug: "available-model", visibility: "list" }],
        });
      const body = JSON.parse(String(init?.body));
      // The plan-use route rejects the string shorthand and max_output_tokens,
      // even though the ordinary Responses API accepts them.
      assert.deepEqual(body, {
        model: "available-model",
        input: [{ role: "user", content: "Reply with OK." }],
        stream: true,
        store: false,
      });
      const events = [
        { type: "response.output_text.delta", delta: "OK" },
        ...(terminal === "missing" ? [] : [{ type: terminal }]),
      ];
      return new Response(
        events
          .map((event) => "data: " + JSON.stringify(event) + "\n\n")
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const verification = adapter.verify({
      credential: { accessToken: "oauth-access" },
      baseUrl: null,
      model: null,
    });
    if (terminal === "response.completed")
      assert.equal(await verification, "available-model");
    else
      await assert.rejects(verification, {
        code: "PROVIDER_VERIFICATION_FAILED",
      });
  }
});
