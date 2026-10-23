import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyModelFailure } from "../service/model-failure-classifier.js";

test("Anthropic errors are classified from the status and body the SDK reports", () => {
  const failure = classifyModelFailure({
    stopReason: "error",
    errorMessage:
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CUabc"}',
  });
  assert.deepEqual(failure, {
    category: "overloaded",
    retryable: true,
    code: "overloaded_error",
    httpStatus: 529,
    requestId: "req_011CUabc",
    message: "Overloaded",
  });
});

test("OpenAI quota errors are not mistaken for retryable rate limits", () => {
  const failure = classifyModelFailure({
    stopReason: "error",
    errorMessage:
      "429 You exceeded your current quota, please check your plan and billing details.",
  });
  assert.equal(failure.category, "quota");
  assert.equal(failure.retryable, false);
  assert.equal(failure.httpStatus, 429);
});

test("context length errors are distinguished from other invalid requests", () => {
  const failure = classifyModelFailure({
    stopReason: "error",
    errorMessage:
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
  });
  assert.equal(failure.category, "context_length");
  assert.equal(failure.code, "invalid_request_error");
});

test("transport and stream failures after a successful response are recognized", () => {
  assert.equal(
    classifyModelFailure({
      stopReason: "error",
      errorMessage: "Connection error.",
    }).category,
    "network",
  );
  assert.equal(
    classifyModelFailure({
      stopReason: "error",
      errorMessage: "Request timed out.",
    }).category,
    "timeout",
  );
  const stream = classifyModelFailure({
    stopReason: "error",
    errorMessage: "Anthropic stream ended without a stop reason",
    lastResponse: { attempt: 1, status: 200, requestId: "req_ok" },
  });
  assert.equal(stream.category, "stream_interrupted");
  assert.equal(stream.httpStatus, 200);
  assert.equal(stream.requestId, "req_ok");
  assert.equal(stream.retryable, true);
});

test("the provider's last response explains a failure the SDK message does not", () => {
  const failure = classifyModelFailure({
    stopReason: "error",
    errorMessage: "An unknown error occurred",
    lastResponse: {
      attempt: 2,
      status: 401,
      errorType: "authentication_error",
      requestId: "req_auth",
    },
  });
  assert.equal(failure.category, "authentication");
  assert.equal(failure.code, "authentication_error");
  assert.equal(failure.httpStatus, 401);
  assert.equal(failure.retryable, false);
});

test("cancellations and refused Fast requests have their own categories", () => {
  assert.equal(
    classifyModelFailure({
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    }).category,
    "cancelled",
  );
  assert.equal(
    classifyModelFailure({ stopReason: "error", speedFailure: "rejected" })
      .category,
    "fast_mode_rejected",
  );
  assert.equal(
    classifyModelFailure({ stopReason: "error", speedFailure: "limited" })
      .category,
    "fast_mode_limited",
  );
});

test("provider explanations are redacted and bounded", () => {
  const failure = classifyModelFailure({
    stopReason: "error",
    errorMessage: `401 {"error":{"message":"Incorrect API key provided: sk-proj-abcdefghijklmnop. ${"x".repeat(600)}","type":"invalid_request_error","code":"invalid_api_key"}}`,
  });
  assert.equal(failure.category, "authentication");
  assert.ok(!failure.message?.includes("abcdefghijklmnop"));
  assert.ok((failure.message?.length ?? 0) <= 300);
});

test("only an error's own message is kept, never the rest of a provider's error body", () => {
  const input = "The private launch date is next Tuesday";
  const withoutMessage = classifyModelFailure({
    stopReason: "error",
    errorMessage: `400 ${JSON.stringify({ error: { type: "invalid_request_error", input } })}`,
  });
  assert.deepEqual(withoutMessage, {
    category: "invalid_request",
    retryable: false,
    code: "invalid_request_error",
    httpStatus: 400,
  });
  const quoted = classifyModelFailure({
    stopReason: "error",
    errorMessage: `400 ${JSON.stringify({ error: { message: "Rejected", type: "invalid_request_error", input } })}`,
  });
  assert.equal(quoted.message, "Rejected");
  const unparsable = classifyModelFailure({
    stopReason: "error",
    errorMessage: `400 {"error":{"message":"${input}`,
  });
  assert.equal(unparsable.message, undefined);
  const page = classifyModelFailure({
    stopReason: "error",
    errorMessage: `502 <html><body>Bad gateway for ${input}</body></html>`,
  });
  assert.equal(page.category, "unavailable");
  assert.equal(page.message, undefined, "a non-JSON response body is not kept");
  const transport = classifyModelFailure({
    stopReason: "error",
    errorMessage: "Connection error.",
  });
  assert.equal(transport.category, "network");
  assert.equal(transport.message, "Connection error.");
});

test("words in a provider's echoed input never decide a failure's category", () => {
  const failure = classifyModelFailure({
    stopReason: "error",
    errorMessage: JSON.stringify({
      error: { input: "Explain the rate limit and quota on our API" },
    }),
  });
  assert.equal(failure.category, "unknown");
  assert.equal(failure.message, undefined);
});
