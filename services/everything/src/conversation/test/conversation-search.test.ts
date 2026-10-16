import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ConversationSearchInput } from "../schema/conversation-search.js";
import type { ConversationMessage } from "../model/message.js";
import { ConversationSearchService } from "../service/conversation-search-service.js";
import { conversationSearchTool } from "../tool/conversation-search-tool.js";
import { mainAgentPrompt } from "../../runtime/prompt/main-agent-prompt.js";

const scope = { ownerId: "owner", agentId: "teammate" };
const id = "10000000-0000-4000-8000-000000000001";

/** Build visible chat fixtures with a predictable identity and timestamp. */
function message(text: string): ConversationMessage {
  return { id, role: "user", text, createdAt: "2026-10-01T12:00:00.000Z" };
}

test("search bounds long matches and neighbors, retains metadata and cursors, and uses the caller's scope", async () => {
  const service = new ConversationSearchService({
    /** Receive normalized input and the policy's default result bound. */
    async search(receivedScope, input) {
      assert.deepEqual(receivedScope, scope);
      assert.deepEqual(input, {
        query: "Doorbell",
        limit: 5,
        role: "user",
        before: id,
      });
      return {
        messages: [
          message(`${"x".repeat(5000)}DOORBELL details${"y".repeat(5000)}`),
        ],
        nextCursor: id,
      };
    },
    /** Neighbors share the same scope and matching message identity. */
    async neighbors(receivedScope, receivedId) {
      assert.deepEqual(receivedScope, scope);
      assert.equal(receivedId, id);
      return {
        before: message("previous ".repeat(500)),
        after: message("next reply"),
      };
    },
  });
  const result = await service.search(scope, {
    query: "  Doorbell  ",
    role: "user",
    before: id,
  });
  assert.equal(result.query, "Doorbell");
  assert.equal(result.nextCursor, id);
  const hit = result.matches[0]!;
  assert.equal(hit.message.id, id);
  assert.equal(hit.message.createdAt, "2026-10-01T12:00:00.000Z");
  assert.equal(hit.message.role, "user");
  assert.match(hit.message.excerpt, /DOORBELL details/);
  assert.ok(hit.message.excerpt.length <= 1502);
  assert.equal(hit.message.truncated, true);
  assert.ok(hit.before!.excerpt.length <= 502);
  assert.equal(hit.before!.truncated, true);
  assert.equal(hit.after!.excerpt, "next reply");
  assert.equal(hit.after!.truncated, false);
});

test("short messages stay whole even when their match is near the end", async () => {
  const original = message(`${"x".repeat(900)}needle`);
  const service = new ConversationSearchService({
    search: async () => ({ messages: [original], nextCursor: null }),
    neighbors: async () => ({ before: null, after: null }),
  });
  const result = await service.search(scope, { query: "needle", limit: 1 });
  assert.deepEqual(result.matches, [
    {
      message: {
        id,
        role: original.role,
        createdAt: original.createdAt,
        excerpt: original.text,
        truncated: false,
      },
      before: null,
      after: null,
    },
  ]);
});

test("invalid queries and cancellation never become unrestricted database reads", async () => {
  const service = new ConversationSearchService({
    search: async () => assert.fail("Invalid search reached the database"),
    neighbors: async () => assert.fail("Invalid search read neighbors"),
  });
  for (const input of [
    { query: "" },
    { query: " \n\t " },
    { query: "x".repeat(201) },
    { query: "word", limit: 0 },
    { query: "word", limit: 11 },
    { query: "word", limit: 1.5 },
    { query: "word", before: "invalid" },
    { query: "word", role: "system" },
    { query: "word", agentId: "other" },
  ]) {
    await assert.rejects(
      service.search(scope, input as ConversationSearchInput),
      {
        code: "CONVERSATION_SEARCH_INPUT_INVALID",
      },
    );
  }
  await assert.rejects(
    service.search(scope, { query: "word" }, AbortSignal.abort()),
    { name: "AbortError" },
  );
});

test("cancellation after a search stops adjacent lookups", async () => {
  const controller = new AbortController();
  const service = new ConversationSearchService({
    search: async () => {
      controller.abort();
      return { messages: [message("word")], nextCursor: null };
    },
    neighbors: async () => assert.fail("Cancelled search read neighbors"),
  });
  await assert.rejects(
    service.search(scope, { query: "word" }, controller.signal),
    { name: "AbortError" },
  );
});

test("the model-facing tool binds scope, returns JSON, and teaches main and private sessions to recall saved chat", async () => {
  const expected = { query: "earlier", matches: [], nextCursor: null };
  const controller = new AbortController();
  const tool = conversationSearchTool(
    {
      /** The model supplies only search filters; identity comes from the harness. */
      async search(receivedScope, input, signal) {
        assert.deepEqual(receivedScope, scope);
        assert.deepEqual(input, { query: "earlier", limit: 3 });
        assert.equal(signal, controller.signal);
        return expected;
      },
    },
    scope,
  );
  assert.equal(tool.name, "conversation_search");
  assert.equal(
    Value.Check(tool.parameters, { query: "earlier", ownerId: "other" }),
    false,
  );
  const result = await tool.execute(
    "call",
    { query: "earlier", limit: 3 },
    controller.signal,
    undefined,
    undefined as never,
  );
  assert.deepEqual(
    JSON.parse((result.content[0] as { text: string }).text),
    expected,
  );
  for (const fork of [undefined, { id: "child", parentId: "main" }]) {
    const prompt = mainAgentPrompt(
      { id: scope.agentId, name: "Zip", systemPrompt: "Help" },
      fork,
    );
    assert.match(prompt, /Use conversation_search/);
    assert.match(prompt, /missing after compaction/);
  }
});
