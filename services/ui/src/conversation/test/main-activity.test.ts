import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeStatus } from "@everything/conversation-contracts";
import {
  mainActivityStatus,
  mainTeammateActivity,
  monitorCountLabel,
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
  monitorCount: 0,
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

/** The activity kind a fresh status read shows. */
function kind(runtime: Partial<RuntimeStatus>): string {
  return mainTeammateActivity(snapshot(runtime)).kind;
}

test("the main teammate thinks only while its own turn runs, through to completion, failure, or Stop", () => {
  assert.equal(kind({}), "idle");
  const running = { status: "running" as const, mainRunning: true };
  assert.equal(kind(running), "thinking");
  assert.equal(
    kind({ ...running, typing: true }),
    "thinking",
    "writing a reply is part of the same turn",
  );
  assert.equal(
    kind({ ...running, compacting: true }),
    "thinking",
    "so is summarizing older context",
  );
  assert.equal(kind({ status: "idle" }), "idle");
  assert.equal(
    kind({ status: "error", error: "Your teammate couldn’t finish." }),
    "idle",
  );
});

test("running monitors make an idle main teammate watch, but never outrank its own work", () => {
  assert.deepEqual(mainTeammateActivity(snapshot({ monitorCount: 1 })), {
    kind: "watching",
    monitors: 1,
  });
  assert.deepEqual(mainTeammateActivity(snapshot({ monitorCount: 3 })), {
    kind: "watching",
    monitors: 3,
  });
  assert.equal(
    kind({ status: "running", mainRunning: true, monitorCount: 3 }),
    "thinking",
  );
  assert.equal(
    kind({ status: "error", monitorCount: 2 }),
    "watching",
    "a failed turn leaves its monitors running",
  );
  assert.equal(kind({ monitorCount: 0 }), "idle");
});

test("background teammates alone never make the main teammate look busy", () => {
  assert.equal(
    kind({ status: "running", mainRunning: false, backgroundCount: 3 }),
    "idle",
  );
  assert.deepEqual(
    mainTeammateActivity(
      snapshot({
        status: "running",
        mainRunning: false,
        backgroundCount: 3,
        monitorCount: 2,
      }),
    ),
    { kind: "watching", monitors: 2 },
    "monitors still show beside background work",
  );
  assert.equal(
    kind({ status: "running", mainRunning: true, backgroundCount: 3 }),
    "thinking",
    "main and background work show together",
  );
});

test("counts are named in the singular and plural, and announced once per state", () => {
  assert.equal(monitorCountLabel(1), "1 monitor running");
  assert.equal(monitorCountLabel(2), "2 monitors running");
  assert.equal(monitorCountLabel(12), "12 monitors running");
  assert.equal(
    mainActivityStatus("Avery", { kind: "thinking" }),
    "Avery is working",
  );
  assert.equal(
    mainActivityStatus("Avery", { kind: "watching", monitors: 1 }),
    "Avery is watching 1 monitor",
  );
  assert.equal(
    mainActivityStatus("Avery", { kind: "watching", monitors: 4 }),
    "Avery is watching 4 monitors",
  );
  assert.equal(mainActivityStatus("Avery", { kind: "idle" }), "");
});

test("an API without these fields, or with an invalid count, keeps the ordinary avatar", () => {
  // A server from before the fields sends the rest of the status unchanged.
  const { mainRunning, monitorCount, ...older } = {
    ...idle,
    status: "running" as const,
  };
  assert.equal(mainRunning, false);
  assert.equal(monitorCount, 0);
  assert.equal(
    mainTeammateActivity({
      isSuccess: true,
      isFetchedAfterMount: true,
      data: { runtime: older as RuntimeStatus },
    }).kind,
    "idle",
  );
  for (const invalid of [-1, 1.5, Number.NaN])
    assert.equal(kind({ monitorCount: invalid }), "idle", String(invalid));
});

test("loading, cached, and failed snapshots never show stale work or monitors", () => {
  const busy = { status: "running" as const, mainRunning: true };
  const watching = { monitorCount: 2 };
  assert.equal(
    mainTeammateActivity({ isSuccess: false, isFetchedAfterMount: false }).kind,
    "idle",
    "the first read is still loading",
  );
  for (const runtime of [busy, watching]) {
    assert.equal(
      mainTeammateActivity(snapshot(runtime, { isFetchedAfterMount: false }))
        .kind,
      "idle",
      "a cached result from an earlier visit waits for a fresh read",
    );
    assert.equal(
      mainTeammateActivity(snapshot(runtime, { isSuccess: false })).kind,
      "idle",
      "a failed refresh keeps its last data but awaits reconnection",
    );
  }
  assert.equal(
    kind(busy),
    "thinking",
    "a successful reconnection shows current work again",
  );
  assert.equal(kind(watching), "watching");
});
