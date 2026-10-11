import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthenticatedTransport } from "../adapter/authenticated-transport.js";
import { HttpAgentDirectory } from "../../agent/adapter/http-agent-directory.js";

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
