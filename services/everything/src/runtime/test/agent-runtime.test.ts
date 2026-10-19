import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "../interface/agent-session.js";
import { AgentRuntime } from "../service/agent-runtime.js";
import {
  FastModeLimitedError,
  FastModeRejectedError,
} from "../error/runtime-errors.js";

/** A session whose turns run until aborted, or fail when prompted with "error" or a Fast refusal. */
function session() {
  let finish: (() => void) | undefined;
  let disposed = false;
  const fake: AgentSession = {
    id: "session",
    compacting: false,
    compactionStartedAt: null,
    lastToolName: undefined,
    typing: false,
    /** Remain active until aborted, or reject like a failed provider call. */
    async prompt(text) {
      if (text === "error") throw new Error("secret provider detail");
      if (text === "fast-rejected") throw new FastModeRejectedError();
      if (text === "fast-limited") throw new FastModeLimitedError();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    /** End the active turn. */
    async abort() {
      finish?.();
    },
    /** Record resource release. */
    async dispose() {
      disposed = true;
    },
  };
  return { fake, disposed: () => disposed };
}

test("refuses to overlap turns until the active one is stopped", async () => {
  const runtime = new AgentRuntime(session().fake);
  const first = runtime.start("first");
  assert.deepEqual(runtime.status, {
    status: "running",
    mainRunning: true,
    compacting: false,
    compactionStartedAt: null,
    typing: false,
    sessionId: "session",
    backgroundCount: 0,
    runId: first,
    error: null,
  });
  assert.throws(() => runtime.start("overlap"), /Stop the active turn/);
  await runtime.stop();
  assert.equal(runtime.status.status, "idle");
  assert.equal(runtime.status.mainRunning, false);
  assert.notEqual(runtime.start("second"), first);
  await runtime.stop();
});

test("reports provider failures without their details and clears them when stopped", async () => {
  const runtime = new AgentRuntime(session().fake);
  runtime.start("error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.status.status, "error");
  assert.equal(runtime.status.mainRunning, false);
  assert.equal(runtime.status.error?.includes("secret"), false);
  await runtime.stop();
  assert.equal(runtime.status.error, null);
});

test("closing stops the active turn before releasing the session", async () => {
  const { fake, disposed } = session();
  const runtime = new AgentRuntime(fake);
  runtime.start("work");
  await runtime.close();
  assert.equal(runtime.status.status, "idle");
  assert.equal(disposed(), true);
});

test("a refused Fast request reports how to recover instead of the generic provider failure", async () => {
  for (const [text, error] of [
    ["fast-rejected", new FastModeRejectedError().message],
    ["fast-limited", new FastModeLimitedError().message],
  ] as const) {
    const runtime = new AgentRuntime(session().fake);
    runtime.start(text);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.status.status, "error");
    assert.equal(runtime.status.error, error);
    assert.match(runtime.status.error!, /Fast mode/);
    await runtime.stop();
    assert.equal(runtime.status.error, null);
  }
});

test("main activity is reported apart from background teammates", async () => {
  const { fake } = session();
  const background = {
    running: true,
    mainRunning: false,
    failed: false,
    activeCount: 1,
  };
  const runtime = new AgentRuntime({ ...fake, background });
  /** Read only the fields that separate main and background activity. */
  const activity = () => {
    const { status, mainRunning, backgroundCount } = runtime.status;
    return { status, mainRunning, backgroundCount };
  };
  assert.deepEqual(activity(), {
    status: "running",
    mainRunning: false,
    backgroundCount: 1,
  });
  background.mainRunning = true;
  assert.equal(activity().mainRunning, true, "a fork's result woke main");
  Object.assign(background, {
    running: false,
    mainRunning: false,
    activeCount: 0,
  });
  assert.deepEqual(activity(), {
    status: "idle",
    mainRunning: false,
    backgroundCount: 0,
  });
  runtime.start("work");
  assert.equal(activity().mainRunning, true);
  await runtime.stop();
  assert.deepEqual(activity(), {
    status: "idle",
    mainRunning: false,
    backgroundCount: 0,
  });
});
