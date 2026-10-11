import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { agentController } from "../controller/agent-controller.js";
import type { AgentCatalog } from "../interface/agent-catalog.js";
import type { AgentRemoval } from "../interface/agent-removal.js";
import type { AgentDefinition } from "../model/agent.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** Build a stored definition, including the owner the API must never expose. */
function definition(name: string): AgentDefinition {
  return {
    id: agentId,
    ownerId: "owner",
    name,
    systemPrompt: "Reply deliberately",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Mount the controller as the HTTP application does, recording calls to its dependencies. */
async function fixture(): Promise<{
  app: FastifyInstance;
  calls: string[];
}> {
  const calls: string[] = [];
  const agents: Omit<AgentCatalog, "delete"> = {
    /** Record listing for the authenticated owner. */
    async list(ownerId) {
      calls.push(`list:${ownerId}`);
      return [definition("Listed")];
    },
    /** Record the validated creation input. */
    async create(ownerId, input) {
      calls.push(`create:${ownerId}:${input.name}`);
      return definition(input.name);
    },
    /** Resolve any requested identifier. */
    async get(ownerId, id) {
      calls.push(`get:${ownerId}:${id}`);
      return definition("Found");
    },
  };
  const removal: AgentRemoval = {
    /** Record deletion through the runtime-aware lifecycle. */
    async delete(ownerId, id) {
      calls.push(`remove:${ownerId}:${id}`);
    },
  };
  const app = authenticatedTestServer();
  await agentController(app, agents, removal);
  return { app, calls };
}

test("creates a definition and hides its owner", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/agents",
    payload: { name: "Chosen", systemPrompt: "Help" },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(Object.keys(response.json()).sort(), [
    "createdAt",
    "id",
    "name",
    "systemPrompt",
  ]);
  assert.deepEqual(calls, ["create:owner:Chosen"]);
});

test("rejects blank, oversized, incomplete, and unexpected definition input", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  for (const payload of [
    { name: " ", systemPrompt: "Help" },
    { name: "Chosen", systemPrompt: "\n" },
    { name: "x".repeat(81), systemPrompt: "Help" },
    { name: "Chosen", systemPrompt: "x".repeat(16001) },
    { name: "Chosen" },
    { name: "Chosen", systemPrompt: "Help", ownerId: "someone-else" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().code, "INVALID_REQUEST");
  }
  assert.deepEqual(calls, []);
});

test("lists and reads only through the authenticated owner", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  const listed = await app.inject({ url: "/agents" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().agents[0].ownerId, undefined);
  const read = await app.inject({ url: `/agents/${agentId}` });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().ownerId, undefined);
  assert.equal(
    (await app.inject({ url: "/agents/not-a-uuid" })).statusCode,
    400,
  );
  assert.deepEqual(calls, ["list:owner", `get:owner:${agentId}`]);
});

test("deletes through the runtime-aware lifecycle, never the catalog directly", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  const response = await app.inject({
    method: "DELETE",
    url: `/agents/${agentId}`,
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(calls, [`remove:owner:${agentId}`]);
});
