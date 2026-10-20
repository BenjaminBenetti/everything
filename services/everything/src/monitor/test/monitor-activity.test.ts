import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type {
  MonitorResult,
  MonitorStatus,
} from "@everything/workspace-contracts/monitor";
import type { WorkspaceMonitors } from "../../workspace/interface/workspace-monitors.js";
import type { MonitorScope } from "../interface/monitor-operations.js";
import { MonitorService } from "../service/monitor-service.js";

const scope: MonitorScope = {
  ownerId: "owner",
  agentId: "00000000-0000-4000-8000-000000000001",
};

/** A pod whose commands run until the test ends them with a chosen outcome. */
function scriptedPod() {
  const waiting = new Map<string, (result: MonitorResult) => void>();
  const outcomes = new Map<string, MonitorResult>();
  /** A result for `id` with nothing but its status filled in. */
  const result = (id: string, status: MonitorStatus): MonitorResult => ({
    id,
    status,
    exitCode: status === "exited" ? 0 : status === "failed" ? 1 : null,
    signal: null,
    output: "",
    outputBytes: 0,
    truncated: false,
    log: `.monitors/${id}.log`,
    logTruncated: false,
    reason: null,
    startedAt: "2026-10-19T00:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-10-19T00:01:00.000Z",
  });
  const workspace: WorkspaceMonitors = {
    /** Start a command that keeps running until the test ends it. */
    async start() {
      return result(randomUUID(), "running");
    },
    /** Hold the wait until the command ends, as the pod's long poll does. */
    wait(_agentId, id, signal) {
      const ended = outcomes.get(id);
      if (ended) return Promise.resolve(ended);
      return new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    /** Stop the command and answer any wait with the same outcome. */
    async cancel(_agentId, id) {
      const cancelled = result(id, "cancelled");
      outcomes.set(id, cancelled);
      waiting.get(id)?.(cancelled);
      return cancelled;
    },
  };
  return {
    workspace,
    /** End a running command with `status`, as its exit, failure, or timeout would. */
    end(id: string, status: MonitorStatus) {
      const ended = result(id, status);
      outcomes.set(id, ended);
      waiting.get(id)?.(ended);
    },
  };
}

/** Follow scripted commands, accepting completion events only while they are not held. */
function fixture(context: TestContext) {
  const pod = scriptedPod();
  const delivered: string[] = [];
  let held: Promise<void> | undefined;
  const monitors = new MonitorService(
    pod.workspace,
    {
      /** Accept the event once deliveries are released. */
      wakeup: async (_scope, input) => {
        await held;
        delivered.push(input.task);
      },
    },
    () => {},
  );
  context.after(() => monitors.close());
  return {
    pod,
    monitors,
    delivered,
    /** Keep completion events waiting until the returned function releases them. */
    hold() {
      let release!: () => void;
      held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        held = undefined;
        release();
      };
    },
  };
}

/** Wait for following and delivery to catch up, with a bounded deadline. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "The monitors did not settle");
    await delay(5);
  }
}

test("the running count follows each teammate's commands through success, failure, timeout, delivery, and stop", async (context) => {
  const { pod, monitors, delivered, hold } = fixture(context);
  const other = { ...scope, agentId: "00000000-0000-4000-8000-000000000002" };
  const stranger = { ...scope, ownerId: "someone-else" };
  assert.equal(monitors.runningCount(scope), 0);
  const release = hold();
  const passing = await monitors.start(scope, "main", { command: "build" });
  const failing = await monitors.start(scope, "fork-1", { command: "test" });
  const slow = await monitors.start(scope, "main", { command: "deploy" });
  const stopped = await monitors.start(scope, "main", { command: "watch" });
  await monitors.start(other, "main", { command: "watch" });
  assert.equal(
    monitors.runningCount(scope),
    4,
    "a background teammate's monitor counts for its teammate",
  );
  assert.equal(monitors.runningCount(other), 1);
  assert.equal(monitors.runningCount(stranger), 0);

  pod.end(passing.id, "exited");
  await until(() => monitors.runningCount(scope) === 3);
  assert.equal(
    monitors.list(scope).length,
    4,
    "its event is still owed, but the command has ended",
  );
  pod.end(failing.id, "failed");
  await until(() => monitors.runningCount(scope) === 2);
  pod.end(slow.id, "timed-out");
  await until(() => monitors.runningCount(scope) === 1);
  await monitors.stop(scope, stopped.id);
  assert.equal(monitors.runningCount(scope), 0);
  assert.equal(delivered.length, 0);

  release();
  await until(() => delivered.length === 3);
  assert.equal(monitors.runningCount(scope), 0);
  assert.deepEqual(monitors.list(scope), []);
  assert.equal(monitors.runningCount(other), 1);
  await monitors.stopAgent(other.agentId);
  assert.equal(monitors.runningCount(other), 0);
});

test("the count never goes below zero when stops and outcomes overlap", async (context) => {
  const { pod, monitors } = fixture(context);
  const racing = await monitors.start(scope, "main", { command: "watch" });
  const stopping = monitors.stop(scope, racing.id);
  pod.end(racing.id, "exited");
  await stopping.catch(() => {});
  await until(() => monitors.list(scope).length === 0);
  assert.equal(monitors.runningCount(scope), 0);
  await monitors.stopAgent(scope.agentId);
  await monitors.stopAgent(scope.agentId);
  assert.equal(monitors.runningCount(scope), 0);
});
