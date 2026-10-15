import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { UpdateSummaryStore } from "../interface/update-repository.js";
import type { StoredSummaryStatus } from "../model/update-record.js";
import {
  summaryGraceMs,
  type UpdateSummaryInput,
} from "../model/update-summary.js";
import { UpdateSummaryScheduler } from "../service/update-summary-scheduler.js";

/** Model the store's atomic, owner-scoped claim independently of a particular scheduler instance. */
function fixture(count = 5) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `update-${index}`,
    ownerId: "owner",
    createdAt: "2026-10-14T00:00:00Z",
    kind: "message" as const,
    text: `Public message ${index}`,
    inference: null,
    status: "pending" as StoredSummaryStatus,
    read: false,
    summary: null as string | null,
  }));
  const store: UpdateSummaryStore = {
    async pendingSummaries(scope) {
      assert.ok(
        scope.createdBefore.getTime() <= Date.now() - summaryGraceMs + 100,
      );
      return rows.filter((row) => row.status === "pending" && !row.read);
    },
    async claimSummary(scope, id) {
      const row = rows.find(
        (item) =>
          item.id === id &&
          item.ownerId === scope.ownerId &&
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

test("coalesced ticks, competing workers, and restarts do not repeat model calls", async () => {
  const f = fixture();
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const summarizer = {
    async summarize(update: UpdateSummaryInput) {
      calls.push(update.id);
      peak = Math.max(peak, ++active);
      await delay(10);
      active--;
      if (update.id === "update-1") throw new Error("private failure detail");
      return `Summary for ${update.text}`;
    },
  };
  const first = new UpdateSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  const tick = first.refresh();
  assert.equal(first.refresh(), tick);
  await tick;
  assert.equal(peak, 2);
  assert.equal(f.rows[0]!.summary, "Summary for Public message 0");
  assert.equal(f.rows[1]!.status, "failed");
  const restarted = new UpdateSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  await Promise.all([first.refresh(), restarted.refresh()]);
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls).size, 5);
  await Promise.all([first.close(), restarted.close()]);
});

test("receipts arriving before a claim prevent inference, and shutdown aborts an in-flight attempt", async () => {
  const f = fixture(1);
  f.rows[0]!.read = true;
  let calls = 0;
  const failures: string[] = [];
  const scheduler = new UpdateSummaryScheduler(
    f.store,
    {
      async summarize(_update, signal) {
        calls++;
        return new Promise<string>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    },
    () => failures.push("reported"),
  );
  await scheduler.refresh();
  assert.equal(calls, 0);
  f.rows[0]!.read = false;
  const tick = scheduler.refresh();
  while (!calls) await delay(1);
  await scheduler.close();
  await tick;
  assert.equal(f.rows[0]!.status, "failed");
  assert.deepEqual(failures, ["reported"]);
  await scheduler.refresh();
  assert.equal(calls, 1);
});

test("two schedulers racing on a pending batch still call the model once per update", async () => {
  const f = fixture(3);
  const calls: string[] = [];
  const summarizer = {
    async summarize(update: UpdateSummaryInput) {
      calls.push(update.id);
      await delay(10);
      return "Finished the report; needs nothing from you.";
    },
  };
  const first = new UpdateSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  const second = new UpdateSummaryScheduler(
    f.store,
    summarizer,
    () => undefined,
  );
  await Promise.all([first.refresh(), second.refresh()]);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
  await Promise.all([first.close(), second.close()]);
});
