import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticatedTestServer } from "../../http/test/test-server.js";
import type {
  SubagentOperations,
  SubagentScope,
} from "../interface/subagent-operations.js";
import { subagentController } from "../controller/subagent-controller.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";
const subagentId = "8067eadb-6590-4daf-81ad-94248bb91137";
const collection = `/agents/${agentId}/subagent`;
const item = `${collection}/${subagentId}`;

/** Exercise strict request validation and record the authenticated scope of every operation. */
async function fixture() {
  const calls: unknown[] = [];
  const subagent = {
    id: subagentId,
    parentId: "main",
    status: "running" as const,
  };
  /** Record scope separately from user-supplied request bodies and parameters. */
  function record(
    operation: string,
    scope: SubagentScope,
    ...args: unknown[]
  ): void {
    assert.deepEqual(scope, { ownerId: "owner", agentId });
    calls.push([operation, ...args]);
  }
  const operations: SubagentOperations = {
    wakeup: async (scope, input) => {
      record("wakeup", scope, input);
      return subagent;
    },
    create: async (scope, input) => {
      record("create", scope, input);
      return subagent;
    },
    list: async (scope) => {
      record("list", scope);
      return [subagent];
    },
    delete: async (scope, id) => {
      record("delete", scope, id);
    },
    send: async (scope, id, text) => {
      record("send", scope, id, text);
      return subagent;
    },
    messages: async (scope, id, before) => {
      record("messages", scope, id, before);
      return {
        messages: [
          {
            id: "deadbeef",
            role: "user",
            text: "Task",
            createdAt: "now",
            attachments: [],
          },
        ],
        nextCursor: "deadbeef",
      };
    },
  };
  const app = authenticatedTestServer();
  await subagentController(app, operations);
  return { app, calls, subagent };
}

test("subagent endpoints create, list, message, page history, and delete with owner scope", async (context) => {
  const { app, calls, subagent } = await fixture();
  context.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: collection,
    payload: { task: "Research", context: true },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), subagent);
  const wakeup = await app.inject({
    method: "POST",
    url: `${collection}/wakeup`,
    payload: { task: "Remote event", context: true },
  });
  assert.equal(wakeup.statusCode, 202);
  assert.deepEqual(wakeup.json(), subagent);
  assert.deepEqual((await app.inject(collection)).json(), {
    subagents: [subagent],
  });
  const sent = await app.inject({
    method: "POST",
    url: `${item}/messages`,
    payload: { text: "Continue" },
  });
  assert.equal(sent.statusCode, 202);
  assert.deepEqual(sent.json(), subagent);
  const history = await app.inject(`${item}/messages?before=deadbeef`);
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().messages[0].text, "Task");
  assert.equal(history.json().nextCursor, "deadbeef");
  assert.equal(
    (await app.inject({ method: "DELETE", url: item })).statusCode,
    204,
  );
  assert.deepEqual(calls, [
    ["create", { task: "Research", context: true }],
    ["wakeup", { task: "Remote event", context: true }],
    ["list"],
    ["send", subagentId, "Continue"],
    ["messages", subagentId, "deadbeef"],
    ["delete", subagentId],
  ]);
});

test("subagent inputs reject blank tasks, excessive text, forged scope, invalid IDs, and unsafe cursors", async (context) => {
  const { app, calls } = await fixture();
  context.after(() => app.close());
  for (const payload of [
    {},
    { task: " " },
    { task: "x".repeat(32001) },
    { task: "x", context: "true" },
    { task: "x", ownerId: "other" },
    { task: "x", parentId: "other" },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `${collection}/wakeup`,
          payload,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: collection, payload }))
        .statusCode,
      400,
    );
  }
  for (const payload of [
    { text: " " },
    { text: "x".repeat(32001) },
    { text: "x", role: "assistant" },
  ]) {
    assert.equal(
      (await app.inject({ method: "POST", url: `${item}/messages`, payload }))
        .statusCode,
      400,
    );
  }
  for (const url of [
    `/agents/not-a-uuid/subagent`,
    `${collection}/main/messages`,
    `${item}/messages?before=..%2Fsecret`,
    `${item}/messages?before=`,
    `${item}/messages?offset=1`,
  ]) {
    assert.equal((await app.inject(url)).statusCode, 400);
  }
  assert.deepEqual(calls, []);
});
