import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import { updateController } from "../controller/update-controller.js";
import type { UpdateOperations } from "../interface/update-operations.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const messageId = "08debf1a-f4de-4905-89c5-f89631969816";
const updateId = "3b0f8a52-63c4-4d39-9f0e-1f5b2b8f6e0a";

/** Record calls to the update boundary, answering with a fixed page and count. */
function operations(calls: unknown[]): UpdateOperations {
  return {
    /** Return one message update. */
    async list(owner, before) {
      calls.push(["list", owner, before]);
      return {
        updates: [
          {
            id: updateId,
            kind: "message",
            agentId,
            messageId,
            summary: "Needs your choice: A or B?",
            summaryStatus: "ready",
            createdAt: "2026-10-15T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      };
    },
    /** Return a fixed unread count. */
    async count(owner) {
      calls.push(["count", owner]);
      return { unread: 3 };
    },
    /** Record the receipt. */
    async read(owner, agent, ids) {
      calls.push(["read", owner, agent, ids]);
    },
  };
}

test("the feed, its count, and explicit receipts stay separate and use the authenticated owner", async (context) => {
  const calls: unknown[] = [];
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await updateController(app, operations(calls));
  const feed = await app.inject({ url: "/updates" });
  assert.equal(feed.statusCode, 200);
  assert.equal(feed.json().updates[0].kind, "message");
  assert.equal(
    (await app.inject({ url: `/updates?before=${updateId}` })).statusCode,
    200,
  );
  const count = await app.inject({ url: "/updates/count" });
  assert.equal(count.statusCode, 200);
  assert.deepEqual(count.json(), { unread: 3 });
  assert.deepEqual(calls, [
    ["list", "owner", undefined],
    ["list", "owner", updateId],
    ["count", "owner"],
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
  assert.equal(calls.length, 4);
});

test("inaccessible and missing conversations have the same receipt response", async (context) => {
  const app = authenticatedTestServer();
  context.after(() => app.close());
  await updateController(app, {
    ...operations([]),
    /** Report the teammate as absent. */
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
  assert.equal(response.json().code, "AGENT_NOT_FOUND");
});
