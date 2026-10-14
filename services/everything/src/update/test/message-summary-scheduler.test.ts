import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  MessageSummaryInput,
  StoredSummaryStatus,
} from "../model/message-summary.js";
import type { MessageSummaryStore } from "../interface/message-summary-store.js";
import { MessageSummaryScheduler } from "../service/message-summary-scheduler.js";
import { UpdateService } from "../service/update-service.js";

/** Model the store's atomic claim independently of a particular scheduler instance. */
function fixture(count = 5) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    agentId: "teammate",
    ownerId: "owner",
    createdAt: "2026-10-14T00:00:00Z",
    text: `Public message ${index}`,
    inference: null,
    status: "pending" as StoredSummaryStatus,
    read: false,
    summary: null as string | null,
  }));
  const store: MessageSummaryStore = {
    async pendingSummaries(scope) {
      assert.ok(scope.createdBefore.getTime() <= Date.now() - 1400);
      return rows.filter((row) => row.status === "pending" && !row.read);
    },
    async claimSummary(scope, id) {
      const row = rows.find(
        (item) =>
          item.id === id &&
          item.ownerId === scope.ownerId &&
          item.agentId === scope.agentId &&
          !item.read &&
          item.status === "pending",
      );
      if (!row) return undefined;
      row.status = "generating";
      return row;
    },
    async finishSummary(scope, id, summary) {
      const row = rows.find(
        (item) =>
          item.id === id &&
          item.ownerId === scope.ownerId &&
          item.agentId === scope.agentId &&
          item.status === "generating",
      );
      if (row) {
        row.summary = summary;
        row.status = summary === null ? "failed" : "ready";
      }
    },
  };
  return { store, rows };
}

test("coalesced ticks, competing workers, repeated feed reads and restarts do not repeat model calls", async () => {
  const f = fixture();
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const summarizer = {
    async summarize(message: MessageSummaryInput) {
      calls.push(message.id);
      peak = Math.max(peak, ++active);
      await delay(10);
      active--;
      if (message.id === "message-1") throw new Error("private failure detail");
      return `Summary for ${message.text}`;
    },
  };
  const first = new MessageSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  const tick = first.refresh();
  assert.equal(first.refresh(), tick);
  await tick;
  assert.equal(peak, 2);
  assert.equal(f.rows[1]!.status, "failed");
  const restarted = new MessageSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  await Promise.all([first.refresh(), restarted.refresh()]);
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls).size, 5);
  await Promise.all([first.close(), restarted.close()]);
});

test("read receipts arriving before a claim prevent inference, and shutdown aborts an in-flight attempt", async () => {
  const f = fixture(1);
  f.rows[0]!.read = true;
  let calls = 0;
  const scheduler = new MessageSummaryScheduler(
    f.store,
    {
      async summarize(_message, signal) {
        calls++;
        return new Promise<string>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    },
    () => undefined,
  );
  await scheduler.refresh();
  assert.equal(calls, 0);
  f.rows[0]!.read = false;
  const tick = scheduler.refresh();
  while (!calls) await delay(1);
  await scheduler.close();
  await tick;
  assert.equal(f.rows[0]!.status, "failed");
  await scheduler.refresh();
  assert.equal(calls, 1);
});

test("feed reads expose cached model summaries and label pending, failed and abandoned previews without inference", async () => {
  const base = {
    id: "message",
    agentId: "teammate",
    createdAt: "2026-10-14T00:00:00Z",
    text: "Use `2 ** 3` in `__init__.py`.",
    updateSummary: null,
    summaryStartedAt: null,
  };
  const service = new UpdateService({
    async unread({ ownerId }) {
      assert.equal(ownerId, "owner");
      return {
        messages: [
          {
            ...base,
            id: "ready",
            summaryStatus: "ready",
            updateSummary:
              "Use the exponent expression in the initialization file.",
          },
          { ...base, id: "pending", summaryStatus: "pending" },
          { ...base, id: "failed", summaryStatus: "failed" },
          {
            ...base,
            id: "abandoned",
            summaryStatus: "generating",
            summaryStartedAt: new Date(Date.now() - 180_000).toISOString(),
          },
        ],
        nextCursor: null,
      };
    },
    async markRead() {
      assert.fail("Fetching summaries must not acknowledge messages");
    },
  });
  const page = await service.list("owner");
  assert.deepEqual(
    page.updates.map((update) => update.summaryStatus),
    ["ready", "pending", "unavailable", "unavailable"],
  );
  assert.equal(
    page.updates[0]!.summary,
    "Use the exponent expression in the initialization file.",
  );
  assert.equal(page.updates[1]!.summary, base.text);
  assert.deepEqual(await service.list("owner"), page);
});

test("two schedulers racing on a pending batch still call the model once per message", async () => {
  const f = fixture(3);
  const calls: string[] = [];
  const summarizer = {
    async summarize(message: MessageSummaryInput) {
      calls.push(message.id);
      await delay(10);
      return "A model-generated summary";
    },
  };
  const first = new MessageSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  const second = new MessageSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  await Promise.all([first.refresh(), second.refresh()]);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
  await Promise.all([first.close(), second.close()]);
});
