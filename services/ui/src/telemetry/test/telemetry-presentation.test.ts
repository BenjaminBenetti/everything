import assert from "node:assert/strict";
import { test } from "node:test";
import type { TelemetrySpan } from "@everything/telemetry-contracts";
import {
  describeCause,
  formatDuration,
  teammateName,
} from "../model/telemetry-presentation.js";
import { traceTimeline } from "../model/trace-timeline.js";

test("causes are explained in plain words with a next step", () => {
  assert.deepEqual(describeCause("rate_limit", "rate_limit_error"), {
    summary: "The provider’s rate limit was reached.",
    nextStep: "Wait a moment, then send the message again.",
  });
  assert.equal(
    describeCause(null, "REPLY_NOT_DELIVERED")?.summary,
    "The teammate finished without replying.",
  );
  assert.equal(describeCause("something_new", "UNKNOWN_CODE"), null);
});

test("durations use a readable unit and teammates fall back gracefully", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(0.2), "<1 ms");
  assert.equal(formatDuration(42.4), "42 ms");
  assert.equal(formatDuration(1_450), "1.4 s");
  assert.equal(formatDuration(125_000), "2 min 5 s");
  assert.equal(teammateName(null, []), null);
  assert.equal(teammateName("a", [{ id: "a", name: "Avery" }]), "Avery");
  assert.equal(
    teammateName("gone", [{ id: "a", name: "Avery" }]),
    "Removed teammate",
  );
});

/** A span starting `start` milliseconds into the trace. */
function span(
  id: string,
  parentSpanId: string | null,
  start: number,
  durationMs: number,
): TelemetrySpan {
  return {
    id,
    source: "spans",
    time: new Date(Date.UTC(2026, 9, 23, 12, 0, 0, start)).toISOString(),
    startTime: new Date(Date.UTC(2026, 9, 23, 12, 0, 0, start)).toISOString(),
    type: "turn",
    severity: "info",
    outcome: "success",
    name: id,
    title: id,
    category: null,
    code: null,
    httpStatus: null,
    durationMs,
    agentId: null,
    provider: null,
    model: null,
    traceId: "5b8efff798038103d269b633813fc60c",
    spanId: id,
    parentSpanId,
    kind: "internal",
    statusMessage: null,
    textWithheld: false,
    details: [],
    events: [],
  };
}

test("a trace is ordered as a tree on one time axis, with orphans and cycles shown at the top level", () => {
  const timeline = traceTimeline([
    span("request", "turn", 100, 50),
    span("turn", null, 0, 1_000),
    span("prompt", "turn", 10, 900),
    span("orphan", "missing", 500, 100),
    span("cycle-a", "cycle-b", 600, 10),
    span("cycle-b", "cycle-a", 610, 10),
  ]);
  assert.equal(timeline.durationMs, 1_000);
  assert.deepEqual(
    timeline.rows.map(({ span, depth }) => [span.id, depth]),
    [
      ["turn", 0],
      ["prompt", 1],
      ["request", 1],
      ["orphan", 0],
      ["cycle-a", 0],
      ["cycle-b", 1],
    ],
  );
  const prompt = timeline.rows.find(({ span }) => span.id === "prompt")!;
  assert.equal(prompt.offset, 0.01);
  assert.equal(prompt.width, 0.9);
  assert.deepEqual(traceTimeline([]), { rows: [], durationMs: 0 });
});
