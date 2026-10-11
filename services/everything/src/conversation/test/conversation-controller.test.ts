import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { unloadedRuntimeStatus } from "../../runtime/model/runtime-status.js";
import { conversationController } from "../controller/conversation-controller.js";
import type { ConversationOperations } from "../interface/conversation-operations.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** Mount the controller as the HTTP application does, recording calls to the conversation boundary. */
async function fixture(): Promise<{
  app: FastifyInstance;
  calls: string[];
}> {
  const calls: string[] = [];
  const conversations: ConversationOperations = {
    /** Return one visible message. */
    async list(ownerId, id) {
      calls.push(`list:${ownerId}:${id}`);
      return [{ id: "message", role: "user", text: "hi", createdAt: "now" }];
    },
    /** Acknowledge the accepted message and its run. */
    async send(ownerId, id, text) {
      calls.push(`send:${ownerId}:${id}:${text}`);
      return { messageId: "message", runId: "run" };
    },
    /** Report an agent that has not run in this process. */
    async status(ownerId, id) {
      calls.push(`status:${ownerId}:${id}`);
      return unloadedRuntimeStatus;
    },
    /** Record the interruption request. */
    async interrupt(ownerId, id) {
      calls.push(`interrupt:${ownerId}:${id}`);
    },
  };
  const app = authenticatedTestServer();
  await conversationController(app, conversations);
  return { app, calls };
}

test("accepts a visible message and acknowledges its run", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: `/agents/${agentId}/messages`,
    payload: { text: "hello" },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { messageId: "message", runId: "run" });
  assert.deepEqual(calls, [`send:owner:${agentId}:hello`]);
});

test("rejects blank, oversized, and unexpected message input", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  for (const payload of [
    { text: " \n" },
    { text: "x".repeat(32001) },
    { text: "hello", role: "assistant" },
    {},
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/messages`,
      payload,
    });
    assert.equal(
      response.statusCode,
      400,
      JSON.stringify(payload).slice(0, 40),
    );
    assert.equal(response.json().code, "INVALID_REQUEST");
  }
  const invalidAgent = await app.inject({
    method: "POST",
    url: "/agents/not-a-uuid/messages",
    payload: { text: "hello" },
  });
  assert.equal(invalidAgent.statusCode, 400);
  assert.deepEqual(calls, []);
});

test("lists messages, reports status, and interrupts for the authenticated owner", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  const listed = await app.inject({ url: `/agents/${agentId}/messages` });
  assert.equal(listed.json().messages.length, 1);
  const status = await app.inject({ url: `/agents/${agentId}/runtime` });
  assert.equal(status.json().status, "idle");
  const interrupted = await app.inject({
    method: "POST",
    url: `/agents/${agentId}/interrupt`,
  });
  assert.equal(interrupted.json().status, "idle");
  assert.deepEqual(calls, [
    `list:owner:${agentId}`,
    `status:owner:${agentId}`,
    `interrupt:owner:${agentId}`,
    `status:owner:${agentId}`,
  ]);
});
