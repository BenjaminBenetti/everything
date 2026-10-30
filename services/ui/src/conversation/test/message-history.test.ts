import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessagePage } from "@everything/conversation-contracts";
import { prependHistory, refreshHistory } from "../model/message-history.js";

/** Build ordered messages with identical timestamps to exercise stable API ordering. */
function page(ids: number[], nextCursor: string | null): MessagePage {
  return {
    messages: ids.map((id) => ({
      id: String(id),
      text: String(id),
      role: "user",
      createdAt: "2026-10-12T00:00:00Z",
      attachments: [],
    })),
    nextCursor,
  };
}

test("live updates retain loaded history and deduplicate messages at page boundaries", () => {
  const history = prependHistory(page([3, 4], "3"), page([1, 2, 3], null));
  assert.deepEqual(
    refreshHistory(history, page([4, 5], "4")),
    page([1, 2, 3, 4, 5], null),
  );
});

test("returning after a long disconnect restarts pagination at the gap instead of silently skipping messages", () => {
  assert.deepEqual(
    refreshHistory(page([1, 2], null), page([200, 201], "200")),
    page([200, 201], "200"),
  );
});
