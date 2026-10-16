import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "../interface/agent-session.js";
import { AgentRuntime } from "../service/agent-runtime.js";

/** A session whose turns run until aborted, or fail when prompted with "error". */
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
  assert.notEqual(runtime.start("second"), first);
  await runtime.stop();
});

test("reports provider failures without their details and clears them when stopped", async () => {
  const runtime = new AgentRuntime(session().fake);
  runtime.start("error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.status.status, "error");
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
