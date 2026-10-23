import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeError,
  redactPath,
  redactText,
  redactUrl,
  safeIdentifier,
  truncationMarker,
} from "../service/telemetry-redactor.js";
import { classifyModelFailure } from "../service/model-failure-classifier.js";

test("credentials in text, JSON, headers, URLs, and keys are redacted", () => {
  const secrets = [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXNlY3JldA",
    "Cookie: everything_session=abc123sessionsecret; Path=/",
    '{"api_key":"sk-ant-api03-SECRETVALUE1234","client_secret":"oauth-secret-77"}',
    "x-api-key=sk-proj-abcdef1234567890",
    "password=hunter2 passphrase: 'correct horse'",
    "connect to postgresql://admin:dbsecret@postgres:5432/everything",
    "GET https://provider.test/v1/chat?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&x=1",
    "token ghp_abcdefghijklmnop1234567890",
    "aws AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "signed AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE= with the session key",
    "sha 4aefbbe2f23cce52ca06ed9f1d4420d3c1a1a8bf0f4fdfb6e0f31a57b1e6a20f",
    "contact owner@example.com",
  ];
  const leaked = [
    "c2lnbmF0dXJlLXNlY3JldA",
    "abc123sessionsecret",
    "SECRETVALUE1234",
    "oauth-secret-77",
    "abcdef1234567890",
    "hunter2",
    "correct horse",
    "dbsecret",
    "AIzaSyDdI0hCZtE6vySjMm",
    "ghp_abcdefghijklmnop",
    "AKIAABCDEFGHIJKLMNOP",
    "b3BlbnNzaC1rZXktdjEAAAAA",
    "AQEBAQEBAQEBAQEBAQEBAQEB",
    "4aefbbe2f23cce52ca06ed9f",
    "owner@example.com",
  ];
  const result = redactText(secrets.join("\n"), 10_000);
  for (const value of leaked)
    assert.ok(!result.includes(value), `${value} leaked: ${result}`);
  assert.match(result, /Authorization: \[redacted\]/);
  assert.match(result, /postgresql:\/\/\[redacted\]@postgres:5432\/everything/);
  assert.match(result, /https:\/\/provider\.test\/v1\/chat\?\[redacted\]/);
});

test("redaction is idempotent and keeps routes, identifiers, and ordinary text", () => {
  const text =
    "POST /v1/agents/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c/messages failed: password=hunter2 Rate limit reached";
  const once = redactText(text, 500);
  assert.equal(redactText(once, 500), once);
  assert.match(
    once,
    /\/v1\/agents\/0b6a3c4e-5f1d-4e2a-8c9b-7d6e5f4a3b2c\/messages/,
  );
  assert.match(once, /password=\[redacted\] Rate limit reached/);
});

test("control characters are removed and long text is truncated with a marker", () => {
  const result = redactText(`line\u0000one\u2028two ${"word ".repeat(20)}`, 30);
  assert.equal(result.length, 30);
  assert.ok(result.endsWith(truncationMarker));
  assert.doesNotMatch(result, /[\u0000\u2028]/);
});

test("URLs and paths lose credentials, query strings, and fragments", () => {
  assert.equal(
    redactUrl("https://user:pass@api.test:8443/v1/models?api_key=secret#frag"),
    "https://api.test:8443/v1/models",
  );
  assert.equal(redactPath("/v1/keys?token=secret"), "/v1/keys");
});

test("identifiers must be short and plain", () => {
  assert.equal(safeIdentifier("req_011CU1x2y3"), "req_011CU1x2y3");
  assert.equal(safeIdentifier(429), "429");
  assert.equal(safeIdentifier("has space"), undefined);
  assert.equal(safeIdentifier("x".repeat(200)), undefined);
  assert.equal(safeIdentifier({ toString: () => "object" }), undefined);
});

test("errors are described by class, code, status, redacted messages of nested causes, and frames only", () => {
  const root = new Error(
    "connect ECONNREFUSED with api_key=sk-nested-secret-999",
  );
  const middle = new Error("provider transport failed: Bearer abcdefghijk123", {
    cause: root,
  });
  const error = Object.assign(
    new TypeError("request failed for https://api.test/v1?token=query-secret", {
      cause: middle,
    }),
    {
      code: "ERR_PROVIDER",
      status: 502,
      response: {
        headers: { authorization: "Bearer header-secret" },
        body: "private body",
      },
      config: { apiKey: "sk-config-secret" },
    },
  );
  const description = describeError(error);
  assert.equal(description.type, "TypeError");
  assert.equal(description.code, "ERR_PROVIDER");
  assert.equal(description.status, 502);
  assert.match(
    description.message ?? "",
    /^request failed .* ← provider transport failed: .* ← connect ECONNREFUSED/,
  );
  const serialized = JSON.stringify(description);
  for (const secret of [
    "sk-nested-secret-999",
    "abcdefghijk123",
    "query-secret",
    "header-secret",
    "private body",
    "sk-config-secret",
  ])
    assert.ok(!serialized.includes(secret), `${secret} leaked`);
  assert.ok(description.stack?.startsWith("at "));
  assert.ok(
    !description.stack?.includes("request failed"),
    "the stack omits the message line",
  );
});

test("non-errors are described safely", () => {
  assert.deepEqual(describeError({ secret: "x" }), {});
  assert.deepEqual(describeError("token=abc12345"), {
    message: "token=[redacted]",
  });
});

test("redaction and classification take bounded time on long, adversarial text", () => {
  const inputs = [
    "a-".repeat(500_000),
    "a".repeat(1_000_000) + "g",
    "a.".repeat(500_000),
    "a+".repeat(500_000),
    "x_".repeat(500_000) + "apikey",
    "invalid ".repeat(125_000),
  ];
  for (const text of inputs) {
    const started = performance.now();
    const result = redactText(text, 400);
    describeError(new Error(text, { cause: new Error(text) }));
    classifyModelFailure({ stopReason: "error", errorMessage: `400 ${text}` });
    assert.ok(result.length <= 400);
    assert.ok(
      performance.now() - started < 1_000,
      `${text.slice(0, 12)}… took ${performance.now() - started} ms`,
    );
  }
});

test("a credential cut by the length bound leaves no fragment", () => {
  const text = `${"word ".repeat(250)}api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789`;
  for (let extra = 0; extra < 80; extra++) {
    const result = redactText("x".repeat(extra) + text, 400);
    assert.doesNotMatch(result, /sk-|abcdef/);
  }
});

test("escaped JSON and multi-value cookie headers are redacted", () => {
  const result = redactText(
    '{\\"api_key\\":\\"abcdef0123456789\\"} Cookie: theme=dark; everything_session=s3ssion-secret-value',
    500,
  );
  assert.doesNotMatch(result, /abcdef0123456789|s3ssion-secret-value/);
  assert.match(result, /Cookie: \[redacted\]/);
});
