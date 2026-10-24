import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import type { ForkableSession } from "../interface/session-forks.js";
import { SessionMailbox } from "../service/session-mailbox.js";
import {
  telemetryScope,
  withTelemetryScope,
} from "../../telemetry/service/telemetry-recorder.js";

// The context manager telemetry runs with, so OpenTelemetry context follows async work here too.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const tracer = new TracerProvider().getTracer("mailbox-test");

/** Another async-local value, standing for any context a sender's work carries. */
const origin = new AsyncLocalStorage<string>();

/** What one prompt saw of the context it ran in. */
interface PromptRun {
  readonly text: string;
  readonly origin: string | undefined;
  readonly ownerId: string | undefined;
  readonly runId: string | undefined;
  readonly traceId: string | undefined;
}

/**
 * A session recording the context each prompt runs in. Prompts named in `gated` wait for
 * `release`; prompts starting with "fail" reject.
 */
function recordingSession(gated: readonly string[] = []) {
  const runs: PromptRun[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session: ForkableSession = {
    id: "main",
    compacting: false,
    compactionStartedAt: null,
    typing: false,
    lastToolName: undefined,
    lastResponse: undefined,
    /** Record the prompt's context, then wait or fail as the test arranges. */
    async prompt(text) {
      const scope = telemetryScope();
      runs.push({
        text,
        origin: origin.getStore(),
        ownerId: scope?.ownerId,
        runId: scope?.runId,
        traceId: trace.getActiveSpan()?.spanContext().traceId,
      });
      if (gated.includes(text)) await gate;
      if (text.startsWith("fail")) throw new Error("The prompt failed");
    },
    async abort() {},
    async dispose() {},
  };
  return { session, runs, release };
}

/** A context inside a user turn: its own trace, owner, and run. */
function userTurn(runId: string) {
  const span = tracer.startSpan(`turn ${runId}`, { root: true });
  return {
    traceId: span.spanContext().traceId,
    context: trace.setSpan(
      withTelemetryScope(
        { ownerId: "owner-a", sessionId: "main", runId },
        ROOT_CONTEXT,
      ),
      span,
    ),
  };
}

test("a message queued behind a running turn runs in the context it was sent in", async () => {
  const { session, runs, release } = recordingSession(["user input"]);
  const mailbox = new SessionMailbox(session);
  const first = origin.run("user-run-A", () =>
    mailbox.submit("user input", "user"),
  );
  const second = origin.run("fork-B-wakeup", () =>
    mailbox.submit("queued private message"),
  );
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    runs.map(({ text, origin }) => ({ text, origin })),
    [
      { text: "user input", origin: "user-run-A" },
      { text: "queued private message", origin: "fork-B-wakeup" },
    ],
  );
});

test("a private message a user turn sends keeps its trace link and owner but is never part of that turn's run", async () => {
  const { session, runs, release } = recordingSession(["user input"]);
  const mailbox = new SessionMailbox(session);
  const turn = userTurn("run-A");
  const [first, second] = context.with(turn.context, () => [
    mailbox.submit("user input", "user"),
    mailbox.submit("private message from a fork"),
  ]);
  release();
  await Promise.all([first, second]);
  assert.equal(runs[0]?.runId, "run-A", "the user's prompt is part of its run");
  assert.equal(runs[0]?.traceId, turn.traceId);
  assert.equal(runs[1]?.text, "private message from a fork");
  assert.equal(runs[1]?.runId, undefined, "the private message is not");
  assert.equal(runs[1]?.ownerId, "owner-a");
  assert.equal(
    runs[1]?.traceId,
    turn.traceId,
    "it is still linked to the work that sent it",
  );
});

test("unscoped work queued behind a user turn does not inherit that turn's trace or run", async () => {
  const { session, runs, release } = recordingSession(["user input"]);
  const mailbox = new SessionMailbox(session);
  const turn = userTurn("run-A");
  const first = context.with(turn.context, () =>
    mailbox.submit("user input", "user"),
  );
  const second = mailbox.submit("background wakeup");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(runs[1], {
    text: "background wakeup",
    origin: undefined,
    ownerId: undefined,
    runId: undefined,
    traceId: undefined,
  });
});

test("held work runs in the context it was sent in, not the one that resumes it", async () => {
  const { session, runs } = recordingSession();
  const mailbox = new SessionMailbox(session, true);
  const sent = userTurn("run-B");
  const queued = context.with(sent.context, () =>
    origin.run("sender", () => mailbox.submit("held message")),
  );
  const resumer = userTurn("run-C");
  context.with(resumer.context, () =>
    origin.run("resumer", () => mailbox.resume()),
  );
  await queued;
  assert.equal(runs[0]?.origin, "sender");
  assert.equal(runs[0]?.traceId, sent.traceId);
  assert.equal(runs[0]?.runId, undefined);
});

test("queued turns keep their order and settle independently, each in its own context", async () => {
  const { session, runs, release } = recordingSession(["first"]);
  const mailbox = new SessionMailbox(session);
  const outcomes = ["first", "fail second", "third"].map((text) =>
    origin.run(text, () => mailbox.submit(text)),
  );
  const user = origin.run("user", () => mailbox.submit("user", "user"));
  release();
  const settled = await Promise.allSettled([...outcomes, user]);
  assert.deepEqual(
    runs.map(({ text, origin }) => [text, origin]),
    [
      ["first", "first"],
      ["user", "user"],
      ["fail second", "fail second"],
      ["third", "third"],
    ],
    "user prompts still run before queued private messages",
  );
  assert.deepEqual(
    settled.map((outcome) => outcome.status),
    ["fulfilled", "rejected", "fulfilled", "fulfilled"],
  );
});

test("stopping resolves queued work without running it in any context", async () => {
  const { session, runs } = recordingSession(["running"]);
  const mailbox = new SessionMailbox(session);
  void mailbox.submit("running");
  const queued = origin.run("sender", () => mailbox.submit("queued"));
  const stopping = mailbox.stop();
  assert.equal(await queued, undefined);
  assert.deepEqual(
    runs.map(({ text }) => text),
    ["running"],
  );
  void stopping;
});
