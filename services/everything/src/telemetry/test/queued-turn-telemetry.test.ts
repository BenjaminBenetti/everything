import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { forkToolNames } from "../../runtime/model/fork-policy.js";
import { sendMessageToolName } from "../../runtime/model/message-delivery.js";
import {
  telemetryAttributes as attribute,
  telemetryEvents,
  telemetrySpans,
} from "../model/telemetry-attributes.js";
import { failure, reply, settled, teammate } from "./runtime-fixtures.js";
import {
  eventsNamed,
  spansNamed,
  startInMemoryTelemetry,
} from "./telemetry-fixtures.js";

const telemetry = startInMemoryTelemetry();

/** A Chat Completions message as the provider receives it. */
interface RequestMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: { function: { name: string } }[];
}

/** The tool whose result ends the conversation so far, if it ends with one. */
function answeredTool(messages: readonly RequestMessage[]): string | undefined {
  if (messages.at(-1)?.role !== "tool") return undefined;
  return messages.at(-2)?.tool_calls?.[0]?.function.name;
}

/** Wait for `predicate`, failing rather than hanging when background work is lost. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${label} did not happen`);
    await delay(10);
  }
}

test("a fork's message queued behind a running user turn starts its own trace, outside that turn's run, after the turn's prompt", async (context) => {
  telemetry.reset();
  const order: string[] = [];
  let forkFinished = false;
  let family!: Awaited<ReturnType<typeof teammate>>["session"];
  const fixture = await teammate(context, async ({ body }) => {
    const messages = (JSON.parse(body) as { messages: RequestMessage[] })
      .messages;
    const said = (text: string) =>
      messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes(text),
      );
    if (said("Background task from main")) {
      order.push("fork");
      return reply("The forecast is sunny.");
    }
    if (said("finished:")) {
      order.push("private message");
      return failure(
        429,
        { error: { message: "Rate limited", type: "rate_limit_error" } },
        { "x-request-id": "req_private_429" },
      );
    }
    const tool = answeredTool(messages);
    if (tool === forkToolNames.fork) {
      // The user's turn is still running until the fork's message is waiting behind it.
      await until(
        () => family.subagents!.list().every((fork) => fork.status === "idle"),
        "the fork finishing",
      );
      await delay(50);
      forkFinished = true;
      order.push("turn continues");
      return reply("", {
        name: sendMessageToolName,
        input: { text: "I asked a fork to check the forecast." },
      });
    }
    if (tool === sendMessageToolName) {
      order.push("turn ends");
      return reply("Done.");
    }
    order.push("turn starts");
    return reply("", {
      name: forkToolNames.fork,
      input: { task: "Check the forecast." },
    });
  });
  family = fixture.session;
  const runId = fixture.runtime.start("Plan the launch");
  await settled(fixture.runtime);
  assert.ok(forkFinished);

  // The queued message runs once the turn's prompt is done, and its model request fails.
  let exported = await telemetry.collect();
  const deadline = Date.now() + 15_000;
  while (
    !eventsNamed(exported, telemetryEvents.modelFailed).length &&
    Date.now() < deadline
  ) {
    await delay(20);
    exported = await telemetry.collect();
  }
  assert.deepEqual(order, [
    "turn starts",
    "fork",
    "turn continues",
    "turn ends",
    "private message",
  ]);

  const [turn] = spansNamed(exported, telemetrySpans.turn);
  assert.ok(turn);
  const userTrace = turn.spanContext().traceId;
  assert.equal(turn.attributes[attribute.runId], runId);
  assert.equal(turn.attributes[attribute.outcome], "success");
  assert.equal(
    eventsNamed(exported, telemetryEvents.turnFailed).length,
    0,
    "the user's turn succeeded; only the queued message failed",
  );
  const prompts = spansNamed(exported, telemetrySpans.prompt);
  const main = prompts.filter(
    (span) => span.attributes[attribute.sessionKind] === "main",
  );
  assert.equal(main.length, 2, "the user's prompt and the queued message's");
  const [user, queued] = [...main].sort(
    (a, b) => startedAt(a) - startedAt(b),
  ) as [ReadableSpan, ReadableSpan];
  assert.equal(user.spanContext().traceId, userTrace);
  assert.equal(user.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(user.attributes[attribute.runId], runId);
  assert.ok(
    endedAt(user) <= startedAt(queued),
    "the queued message waited for the user's prompt",
  );

  assert.notEqual(
    queued.spanContext().traceId,
    userTrace,
    "the queued message has a trace of its own",
  );
  assert.equal(queued.parentSpanContext, undefined);
  assert.equal(queued.attributes[attribute.runId], undefined);
  assert.equal(queued.attributes[attribute.ownerId], "owner-a");
  assert.equal(queued.attributes[attribute.sessionId], family.id);
  assert.ok(
    queued.links.some((link) => link.context.traceId === userTrace),
    "it is linked to the turn whose fork sent it",
  );

  const [fork] = prompts.filter(
    (span) => span.attributes[attribute.sessionKind] === "fork",
  );
  assert.ok(fork);
  assert.notEqual(fork.spanContext().traceId, userTrace);
  assert.notEqual(fork.spanContext().traceId, queued.spanContext().traceId);

  const [failed] = eventsNamed(exported, telemetryEvents.modelFailed);
  assert.equal(failed?.attributes[attribute.requestId], "req_private_429");
  assert.equal(failed?.attributes[attribute.category], "rate_limit");
  assert.equal(failed?.attributes[attribute.runId], undefined);
  assert.equal(failed?.attributes[attribute.ownerId], "owner-a");
  assert.equal(failed?.attributes[attribute.sessionKind], "main");
  assert.equal(
    failed?.spanContext?.traceId,
    queued.spanContext().traceId,
    "the failure belongs to the queued message's trace",
  );
  assert.ok(
    !exported.spans.some(
      (span) =>
        span.spanContext().traceId === userTrace &&
        span.attributes[attribute.requestId] === "req_private_429",
    ),
    "nothing of the queued message is in the user's trace",
  );
});

/** A span's start, in milliseconds. */
function startedAt(span: ReadableSpan): number {
  return span.startTime[0] * 1_000 + span.startTime[1] / 1_000_000;
}

/** A span's end, in milliseconds. */
function endedAt(span: ReadableSpan): number {
  return span.endTime[0] * 1_000 + span.endTime[1] / 1_000_000;
}
