import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthenticatedTransport } from "../adapter/authenticated-transport.js";
import { HttpAgentDirectory } from "../../agent/adapter/http-agent-directory.js";
import { HttpRequestError } from "../model/http-request-error.js";

test("uses same-origin cookies without exposing tokens and sends only definition operations", async () => {
  const requests: { path: string; options: RequestInit }[] = [];
  const transport = createAuthenticatedTransport(
    async (input, options = {}) => {
      requests.push({ path: String(input), options });
      if (options.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ agents: [], id: "agent" });
    },
  );
  const directory = new HttpAgentDirectory(transport);
  await directory.list();
  await directory.create({ name: "Aster", systemPrompt: "Help" });
  await directory.update("agent", {
    name: "Nova",
    systemPrompt: "Research and summarize findings.",
    avatarId: "avatar-41",
  });
  assert.equal(await directory.delete("agent"), undefined);
  assert.deepEqual(
    requests.map((request) => request.path),
    ["/v1/agents", "/v1/agents", "/v1/agents/agent", "/v1/agents/agent"],
  );
  assert.equal(
    new Headers(requests[2]?.options.headers).get("Authorization"),
    null,
  );
  assert.equal(requests[2]?.options.credentials, "same-origin");
  assert.equal(
    requests[2]?.options.body,
    JSON.stringify({
      name: "Nova",
      systemPrompt: "Research and summarize findings.",
      avatarId: "avatar-41",
    }),
  );
  assert.equal(requests[2]?.options.cache, "no-store");
  assert.equal(requests[2]?.options.redirect, "error");
  assert.equal(requests[3]?.options.method, "DELETE");
  assert.equal(requests[3]?.options.body, undefined);
  assert.equal(requests[3]?.options.credentials, "same-origin");
  for (const path of [
    "https://elsewhere.test/v1/agents",
    "/v1/../auth",
    "/v1/\\evil",
  ])
    await assert.rejects(transport.request(path), /Invalid API path/);
  assert.equal(requests.length, 4);
});

test("server errors never reveal response content", async () => {
  for (const status of [401, 404, 429, 500]) {
    const transport = createAuthenticatedTransport(
      async () => new Response("Private upstream details", { status }),
    );
    await assert.rejects(
      transport.request("/v1/agents"),
      (error) => error instanceof Error && !error.message.includes("Private"),
    );
  }
});

test("uploads raw bytes with their own content type under the same path and request rules", async () => {
  const requests: { path: string; options: RequestInit }[] = [];
  const transport = createAuthenticatedTransport(
    async (input, options = {}) => {
      requests.push({ path: String(input), options });
      return Response.json({ text: "ok" });
    },
  );
  const body = new Blob(["bytes"]);
  assert.deepEqual(
    await transport.upload(
      "/v1/agents/a/voice/transcriptions",
      body,
      "audio/webm;codecs=opus",
    ),
    { text: "ok" },
  );
  const headers = new Headers(requests[0]?.options.headers);
  assert.equal(headers.get("Content-Type"), "audio/webm;codecs=opus");
  assert.equal(requests[0]?.options.body, body);
  assert.equal(requests[0]?.options.credentials, "same-origin");
  assert.equal(requests[0]?.options.redirect, "error");
  for (const path of ["https://elsewhere.test/v1/x", "/v1/../auth", "/v1/\\x"])
    await assert.rejects(
      transport.upload(path, body, "audio/webm"),
      /Invalid API path/,
    );
  assert.equal(requests.length, 1);
});

test("failures keep only a well-formed error code from the body, never its message", async () => {
  for (const [body, expected] of [
    [{ code: "KEY_NAME_TAKEN", message: "Private details" }, "KEY_NAME_TAKEN"],
    [{ code: "not a code with spaces" }, undefined],
    [{ code: 42 }, undefined],
    ["Private upstream details", undefined],
  ] as const) {
    const transport = createAuthenticatedTransport(async () =>
      typeof body === "string"
        ? new Response(body, { status: 409 })
        : Response.json(body, { status: 409 }),
    );
    await assert.rejects(transport.request("/v1/keys"), (error) => {
      assert.ok(error instanceof HttpRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, expected);
      assert.ok(!error.message.includes("Private"));
      return true;
    });
  }
});
