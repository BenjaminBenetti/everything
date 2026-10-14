import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { updateController } from "../controller/update-controller.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const messageId = "08debf1a-f4de-4905-89c5-f89631969816";

test("fetching and explicit receipts remain separate and use the authenticated owner", async (context) => {
  const calls: unknown[] = [];
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await updateController(app, {
    async list(owner, before) {
      calls.push(["list", owner, before]);
      return { updates: [], nextCursor: null };
    },
    async read(owner, agent, ids) {
      calls.push(["read", owner, agent, ids]);
    },
  });
  assert.equal((await app.inject({ url: "/updates" })).statusCode, 200);
  assert.equal(
    (await app.inject({ url: `/updates?before=${messageId}` })).statusCode,
    200,
  );
  assert.deepEqual(calls, [
    ["list", "owner", undefined],
    ["list", "owner", messageId],
  ]);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/agents/${agentId}/messages/read`,
        payload: { messageIds: [messageId] },
      })
    ).statusCode,
    204,
  );
  assert.deepEqual(calls.at(-1), ["read", "owner", agentId, [messageId]]);
  for (const payload of [
    { messageIds: [] },
    { messageIds: ["invalid"] },
    { messageIds: [messageId, messageId] },
    { messageIds: Array(101).fill(messageId) },
    { messageIds: [messageId], ownerId: "other" },
    { messageIds: [messageId], readAt: "now" },
    {},
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/agents/${agentId}/messages/read`,
          payload,
        })
      ).statusCode,
      400,
    );
  }
  for (const query of ["before=invalid", "ownerId=other", "limit=100000"])
    assert.equal(
      (await app.inject({ url: `/updates?${query}` })).statusCode,
      400,
    );
  assert.equal(calls.length, 3);
});

test("inaccessible and missing conversations have the same receipt response", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await updateController(app, {
    async list() {
      return { updates: [], nextCursor: null };
    },
    async read() {
      throw new AgentNotFoundError();
    },
  });
  const response = await app.inject({
    method: "POST",
    url: `/agents/${agentId}/messages/read`,
    payload: { messageIds: [messageId] },
  });
  assert.equal(response.statusCode, 404);
});
