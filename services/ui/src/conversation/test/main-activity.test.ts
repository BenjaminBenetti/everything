import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeStatus } from "@everything/conversation-contracts";
import {
  mainTeammateWorking,
  type MainActivitySnapshot,
} from "../model/main-activity.js";

/** Idle status as the API reports it for a loaded teammate. */
const idle: RuntimeStatus = {
  status: "idle",
  mainRunning: false,
  compacting: false,
  compactionStartedAt: null,
  typing: false,
  backgroundCount: 0,
  sessionId: "session",
  runId: null,
  error: null,
};

/** A successful read made after the conversation opened, unless overridden. */
function snapshot(
  runtime: Partial<RuntimeStatus>,
  query: Partial<Omit<MainActivitySnapshot, "data">> = {},
): MainActivitySnapshot {
  return {
    isSuccess: true,
    isFetchedAfterMount: true,
    data: { runtime: { ...idle, ...runtime } },
    ...query,
  };
}

test("the main teammate works only while its own turn runs, through to completion, failure, or Stop", () => {
  assert.equal(mainTeammateWorking(snapshot({})), false);
  const running = { status: "running" as const, mainRunning: true };
  assert.equal(mainTeammateWorking(snapshot(running)), true);
  assert.equal(
    mainTeammateWorking(snapshot({ ...running, typing: true })),
    true,
    "writing a reply is part of the same turn",
  );
  assert.equal(
    mainTeammateWorking(snapshot({ ...running, compacting: true })),
    true,
    "so is summarizing older context",
  );
  assert.equal(mainTeammateWorking(snapshot({ status: "idle" })), false);
  assert.equal(
    mainTeammateWorking(
      snapshot({ status: "error", error: "Your teammate couldn’t finish." }),
    ),
    false,
  );
});

test("background teammates alone never make the main teammate look busy", () => {
  assert.equal(
    mainTeammateWorking(
      snapshot({ status: "running", mainRunning: false, backgroundCount: 3 }),
    ),
    false,
  );
  assert.equal(
    mainTeammateWorking(
      snapshot({ status: "running", mainRunning: true, backgroundCount: 3 }),
    ),
    true,
    "main and background work show together",
  );
});

test("an API without the main-session flag keeps the ordinary avatar", () => {
  // A server from before the flag sends the rest of the status unchanged.
  const { mainRunning, ...older } = { ...idle, status: "running" as const };
  assert.equal(mainRunning, false);
  assert.equal(
    mainTeammateWorking({
      isSuccess: true,
      isFetchedAfterMount: true,
      data: { runtime: older as RuntimeStatus },
    }),
    false,
  );
});

test("loading, cached, and failed snapshots never show stale work", () => {
  assert.equal(
    mainTeammateWorking({ isSuccess: false, isFetchedAfterMount: false }),
    false,
    "the first read is still loading",
  );
  assert.equal(
    mainTeammateWorking(
      snapshot(
        { status: "running", mainRunning: true },
        {
          isFetchedAfterMount: false,
        },
      ),
    ),
    false,
    "a cached result from an earlier visit waits for a fresh read",
  );
  assert.equal(
    mainTeammateWorking(
      snapshot({ status: "running", mainRunning: true }, { isSuccess: false }),
    ),
    false,
    "a failed refresh keeps its last data but awaits reconnection",
  );
  assert.equal(
    mainTeammateWorking(snapshot({ status: "running", mainRunning: true })),
    true,
    "a successful reconnection shows current work again",
  );
});
