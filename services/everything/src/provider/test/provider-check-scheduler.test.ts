import assert from "node:assert/strict";
import { test } from "node:test";
import { providerLimits } from "@everything/provider-contracts";
import { ProviderCheckScheduler } from "../service/provider-check-scheduler.js";

const target = {
  id: "connection",
  ownerId: "owner",
  createdAt: "2026-01-01",
  provider: "openai-compatible" as const,
};

test("the daily worker catches up at startup, polls without overlapping, and stops cleanly", async (context) => {
  context.mock.timers.enable({
    apis: ["Date", "setInterval"],
    now: new Date("2026-01-02T00:00:00Z"),
  });
  const cutoffs: Date[] = [];
  const calls: unknown[] = [];
  let pending = Promise.resolve();
  const worker = new ProviderCheckScheduler(
    {
      /** Supply a due identity without giving the worker any credential fields. */
      async list({ checkedBefore }) {
        cutoffs.push(checkedBefore);
        return [target];
      },
    },
    {
      /** Hold one request so multiple timer ticks cannot overlap it. */
      async verifyIfDue(ownerId, provider) {
        calls.push([ownerId, provider]);
        await pending;
      },
    },
    () => assert.fail("Unexpected worker failure"),
  );
  context.after(() => worker.close());
  worker.start();
  await worker.refresh();
  assert.deepEqual(calls, [["owner", "openai-compatible"]]);
  assert.equal(
    cutoffs[0]!.getTime(),
    Date.now() - providerLimits.verificationIntervalMs,
  );
  let finish!: () => void;
  pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  context.mock.timers.tick(60_000);
  const running = worker.refresh();
  context.mock.timers.tick(120_000);
  assert.equal(worker.refresh(), running);
  await Promise.resolve();
  assert.equal(cutoffs.length, 2);
  assert.equal(calls.length, 2);
  let closed = false;
  const closing = worker.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  finish();
  await closing;
  context.mock.timers.tick(60_000);
  await worker.refresh();
  assert.equal(cutoffs.length, 2);
});

test("one operational failure does not prevent checks for another owner", async () => {
  const calls: string[] = [];
  let failures = 0;
  const worker = new ProviderCheckScheduler(
    {
      /** Include separate ownership scopes in one internal maintenance batch. */
      async list() {
        return [target, { ...target, id: "another", ownerId: "another-owner" }];
      },
    },
    {
      /** Simulate persistence failure, independently of a recorded upstream check failure. */
      async verifyIfDue(ownerId) {
        calls.push(ownerId);
        if (ownerId === "owner") throw new Error("sensitive storage details");
      },
    },
    () => {
      failures++;
    },
  );
  await worker.refresh();
  await worker.close();
  assert.deepEqual(calls, ["owner", "another-owner"]);
  assert.equal(failures, 1);
});
