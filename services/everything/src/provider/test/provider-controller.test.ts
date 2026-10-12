import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConnections } from "../interface/provider-connections.js";
import { providerController } from "../controller/provider-controller.js";
import { chatGptCallbackController } from "../controller/chatgpt-callback-controller.js";
import { authenticatedTestServer } from "../../http/test/test-server.js";

test("provider routes derive ownership from authentication and reject unsupported inputs", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const calls: unknown[] = [];
  const operations = {
    /** Record only schema-validated arguments and the authenticated subject. */
    async save(...args: unknown[]) {
      calls.push(args);
      return { status: "verified" };
    },
  } as unknown as ProviderConnections;
  await providerController(app, operations);
  const saved = await app.inject({
    method: "PUT",
    url: "/providers/anthropic",
    payload: { apiKey: "test-key" },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(calls, [["owner", "anthropic", { apiKey: "test-key" }]]);
  for (const [url, payload] of [
    ["/providers/chatgpt", { apiKey: "test-key" }],
    ["/providers/unknown", { apiKey: "test-key" }],
    ["/providers/anthropic", { ownerId: "someone-else", apiKey: "test-key" }],
    ["/providers/anthropic", { apiKey: "x".repeat(8193) }],
  ] as const) {
    assert.equal(
      (await app.inject({ method: "PUT", url, payload })).statusCode,
      400,
    );
  }
  assert.equal(calls.length, 1);
});

test("loopback callback returns to the configured hostname without exchanging tokens or leaking code into the request path", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  const redirect = "http://127.0.0.1:8080/v1/providers/chatgpt/callback";
  await chatGptCallbackController(
    app,
    "https://everything.example.test",
    redirect,
  );
  const response = await app.inject(
    "/v1/providers/chatgpt/callback?code=temporary&state=attempt&client_id=issued",
  );
  assert.equal(response.statusCode, 302);
  const location = new URL(response.headers.location!);
  assert.equal(location.origin, "https://everything.example.test");
  assert.equal(location.search, "");
  assert.equal(
    new URLSearchParams(location.hash.slice(1)).get("chatgpt"),
    redirect + "?code=temporary&state=attempt&client_id=issued",
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
});
