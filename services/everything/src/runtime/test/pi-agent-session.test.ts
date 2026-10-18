import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession as PiSession } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../adapter/pi-agent-session.js";

type Listener = Parameters<PiSession["subscribe"]>[0];
type Event = Parameters<Listener>[0];

/** Replay native events while recording typing and compaction timestamps after each one. */
function scripted(events: readonly unknown[], now: () => number = Date.now) {
  const seen: boolean[] = [];
  const compactionStarts: (string | null)[] = [];
  let listener: Listener | undefined;
  let session!: PiAgentSession;
  const pi = {
    sessionId: "session",
    isCompacting: false,
    messages: [],
    subscribe(next: Listener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    /** Replay provider events and capture the public activity after each transition. */
    async prompt() {
      for (const event of events) {
        listener?.(event as Event);
        seen.push(session.typing);
        compactionStarts.push(session.compactionStartedAt);
      }
    },
  };
  session = new PiAgentSession(pi as unknown as PiSession, now);
  return { session, seen, compactionStarts };
}

test("compaction timestamps remain stable until completion and restart for each new summary", async () => {
  const first = Date.parse("2026-10-16T04:00:00Z");
  let now = first;
  const { session, compactionStarts } = scripted(
    [
      { type: "compaction_start" },
      outputStart("thinking_start"),
      { type: "compaction_end" },
      { type: "compaction_start" },
      { type: "compaction_end" },
    ],
    () => now++,
  );
  await session.prompt("Continue");
  assert.deepEqual(compactionStarts, [
    new Date(first).toISOString(),
    new Date(first).toISOString(),
    null,
    new Date(first + 1).toISOString(),
    null,
  ]);
  assert.equal(session.compactionStartedAt, null);
});

test("failed or interrupted summaries never leave a stale compaction timestamp", async () => {
  const failed = scripted([
    { type: "compaction_start" },
    { type: "compaction_end", errorMessage: "Provider failed" },
  ]);
  await assert.rejects(failed.session.prompt("Continue"));
  assert.equal(failed.session.compactionStartedAt, null);
  const interrupted = scripted([{ type: "compaction_start" }]);
  await interrupted.session.prompt("Continue");
  assert.ok(interrupted.compactionStarts[0]);
  assert.equal(interrupted.session.compactionStartedAt, null);
});

/** A streamed part of the tool call at index 0, named `name` so far. */
function toolPart(type: "toolcall_start" | "toolcall_delta", name: string) {
  return {
    type: "message_update",
    message: {},
    assistantMessageEvent: {
      type,
      contentIndex: 0,
      delta: "",
      partial: {
        content: [{ type: "toolCall", id: "call", name, arguments: {} }],
      },
    },
  };
}

/** A streamed part of the assistant's own text or reasoning. */
function outputStart(type: "text_start" | "thinking_start") {
  return {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type, contentIndex: 0, partial: { content: [] } },
  };
}

const end = (stopReason: string) => ({
  type: "message_end",
  message: { role: "assistant", stopReason },
});
const executed = (toolName: string) => ({
  type: "tool_execution_end",
  toolCallId: "call",
  toolName,
  result: {},
  isError: false,
});

test("typing lasts from the first part of a send_message call until it is delivered", async () => {
  const { session, seen } = scripted([
    outputStart("thinking_start"),
    toolPart("toolcall_start", "send_message"),
    toolPart("toolcall_delta", "send_message"),
    end("toolUse"),
    executed("send_message"),
  ]);
  await session.prompt("Hello");
  assert.deepEqual(seen, [false, true, true, true, false]);
  assert.equal(session.typing, false);
});

test("other tools, reasoning, and plain answers never count as typing", async () => {
  const { session, seen } = scripted([
    toolPart("toolcall_start", "bash"),
    end("toolUse"),
    executed("bash"),
    outputStart("text_start"),
    end("stop"),
  ]);
  await session.prompt("Work");
  assert.deepEqual(seen, [false, false, false, false, false]);
});

test("a tool named in a later part still counts, and a later call or failure ends typing", async () => {
  const late = scripted([
    toolPart("toolcall_start", ""),
    toolPart("toolcall_delta", "send_message"),
    toolPart("toolcall_start", "bash"),
  ]);
  await late.session.prompt("Hello");
  assert.deepEqual(late.seen, [false, true, false]);
  const failed = scripted([
    toolPart("toolcall_start", "send_message"),
    end("error"),
  ]);
  await failed.session.prompt("Hello");
  assert.deepEqual(failed.seen, [true, false]);
});

test("a refused Fast request ends the turn with its own recovery, and other provider failures stay generic", async () => {
  /** A Pi session whose last response failed with the given speed details, or none. */
  function failed(details?: Record<string, unknown>) {
    const pi = {
      sessionId: "session",
      isCompacting: false,
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "provider detail",
          ...(details
            ? {
                diagnostics: [
                  { type: "inference-speed", timestamp: 1, details },
                ],
              }
            : {}),
        },
      ],
      subscribe: () => () => undefined,
      async prompt() {},
    };
    return new PiAgentSession(pi as unknown as PiSession);
  }
  await assert.rejects(
    failed({
      requested: "fast",
      effective: "unknown",
      failure: "rejected",
    }).prompt("Hi"),
    { code: "FAST_MODE_REJECTED" },
  );
  await assert.rejects(
    failed({
      requested: "fast",
      effective: "unknown",
      failure: "limited",
    }).prompt("Hi"),
    { code: "FAST_MODE_LIMITED" },
  );
  for (const details of [
    { requested: "fast", effective: "unknown" },
    { requested: "standard", effective: "unknown" },
    undefined,
  ])
    await assert.rejects(failed(details).prompt("Hi"), {
      message: "Pi model request failed",
    });
});
