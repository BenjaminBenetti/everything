import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession as PiSession } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../adapter/pi-agent-session.js";

type Listener = Parameters<PiSession["subscribe"]>[0];
type Event = Parameters<Listener>[0];

/** A Pi session that replays scripted events, recording `typing` after each one. */
function scripted(events: readonly unknown[]) {
  const seen: boolean[] = [];
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
    async prompt() {
      for (const event of events) {
        listener?.(event as Event);
        seen.push(session.typing);
      }
    },
  };
  session = new PiAgentSession(pi as unknown as PiSession);
  return { session, seen };
}

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
