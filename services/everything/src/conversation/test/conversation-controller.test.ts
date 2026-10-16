import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { unloadedRuntimeStatus } from "../../runtime/model/runtime-status.js";
import { conversationController } from "../controller/conversation-controller.js";
import type { ConversationOperations } from "../interface/conversation-operations.js";
import type { RuntimeStatus } from "@everything/conversation-contracts";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** Mount the controller as the HTTP application does, recording calls to the conversation boundary. */
async function fixture(
  runtime: RuntimeStatus = unloadedRuntimeStatus,
): Promise<{
  app: FastifyInstance;
  calls: string[];
}> {
  const calls: string[] = [];
  const conversations: ConversationOperations = {
    /** Return one visible message. */
    async list(ownerId, id, before) {
      calls.push(`list:${ownerId}:${id}${before ? `:${before}` : ""}`);
      return {
        messages: [
          { id: "message", role: "user", text: "hi", createdAt: "now" },
        ],
        nextCursor: null,
      };
    },
    /** Acknowledge the accepted message and its run. */
    async send(ownerId, id, text) {
      calls.push(`send:${ownerId}:${id}:${text}`);
      return { messageId: "message", runId: "run" };
    },
    /** Report the supplied runtime snapshot for the authenticated teammate. */
    async status(ownerId, id) {
      calls.push(`status:${ownerId}:${id}`);
      return runtime;
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

test("runtime responses preserve the server compaction timestamp", async (context) => {
  const runtime: RuntimeStatus = {
    ...unloadedRuntimeStatus,
    status: "running",
    compacting: true,
    compactionStartedAt: "2026-10-16T04:00:00.000Z",
  };
  const { app } = await fixture(runtime);
  context.after(() => app.close());
  const response = await app.inject({ url: `/agents/${agentId}/runtime` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), runtime);
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

test("validates history cursors and forwards them with the authenticated scope", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  const cursor = "08debf1a-f4de-4905-89c5-f89631969816";
  const response = await app.inject({
    url: `/agents/${agentId}/messages?before=${cursor}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().nextCursor, null);
  assert.deepEqual(calls, [`list:owner:${agentId}:${cursor}`]);
  for (const query of ["before=invalid", "before=", "offset=100"]) {
    assert.equal(
      (await app.inject({ url: `/agents/${agentId}/messages?${query}` }))
        .statusCode,
      400,
    );
  }
  assert.equal(calls.length, 1);
});
