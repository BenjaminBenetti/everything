import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdateFeedStore } from "../interface/update-repository.js";
import type { StoredUpdate } from "../model/stored-update.js";
import { UpdateService } from "../service/update-service.js";

const base: StoredUpdate = {
  id: "update",
  ownerId: "owner",
  createdAt: "2026-10-14T00:00:00.000Z",
  kind: "message",
  agentId: "teammate",
  messageId: "message",
  summary: null,
  summaryStatus: "pending",
  summaryStartedAt: null,
  readAt: null,
  sourceText: "Use `2 ** 3`\n\tin `__init__.py`.",
};

/** A feed store that records receipts and refuses to be read as anyone but the owner. */
function store(updates: StoredUpdate[]) {
  const receipts: unknown[] = [];
  const feed: UpdateFeedStore = {
    async unread({ ownerId }, before) {
      assert.equal(ownerId, "owner");
      assert.equal(before, "cursor");
      return { updates, nextCursor: "next" };
    },
    async countUnread({ ownerId }) {
      assert.equal(ownerId, "owner");
      return updates.length;
    },
    async readMessages(scope, messageIds) {
      receipts.push([scope, messageIds]);
    },
  };
  return { feed, receipts };
}

test("message updates map to their public variant, with cached summaries or labeled previews", async () => {
  const { feed, receipts } = store([
    {
      ...base,
      id: "ready",
      summaryStatus: "ready",
      summary: "Finished the exponent fix in __init__.py.",
    },
    { ...base, id: "pending" },
    {
      ...base,
      id: "generating",
      summaryStatus: "generating",
      summaryStartedAt: new Date().toISOString(),
    },
    { ...base, id: "failed", summaryStatus: "failed" },
    {
      ...base,
      id: "abandoned",
      summaryStatus: "generating",
      summaryStartedAt: new Date(Date.now() - 180_000).toISOString(),
    },
  ]);
  const service = new UpdateService(feed);
  const page = await service.list("owner", "cursor");
  assert.equal(page.nextCursor, "next");
  assert.deepEqual(page.updates[0], {
    id: "ready",
    kind: "message",
    agentId: "teammate",
    messageId: "message",
    summary: "Finished the exponent fix in __init__.py.",
    summaryStatus: "ready",
    createdAt: base.createdAt,
  });
  assert.deepEqual(
    page.updates.map((update) => update.summaryStatus),
    ["ready", "pending", "pending", "unavailable", "unavailable"],
  );
  assert.equal(page.updates[1]!.summary, "Use `2 ** 3` in `__init__.py`.");
  assert.equal("ownerId" in page.updates[1]!, false);
  assert.equal("sourceText" in page.updates[1]!, false);
  assert.deepEqual(await service.list("owner", "cursor"), page);
  assert.deepEqual(receipts, [], "Reading the feed never acknowledges it");
});

test("the count reports unread updates, and receipts are scoped to the owner's teammate", async () => {
  const { feed, receipts } = store([base, { ...base, id: "second" }]);
  const service = new UpdateService(feed);
  assert.deepEqual(await service.count("owner"), { unread: 2 });
  await service.read("owner", "teammate", ["message"]);
  assert.deepEqual(receipts, [
    [{ ownerId: "owner", agentId: "teammate" }, ["message"]],
  ]);
});
