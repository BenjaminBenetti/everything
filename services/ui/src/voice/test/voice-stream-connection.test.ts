import assert from "node:assert/strict";
import { mock, test, type TestContext } from "node:test";
import { VoiceStreamConnection } from "../adapter/voice-stream-connection.js";
import { VoiceInputError } from "../model/voice-input-error.js";

/** A WebSocket stand-in the test drives: it records what is sent and delivers messages on demand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;
  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = "blob";
  readonly sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  /** The server accepted the upgrade. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The server sent a JSON message. */
  reply(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** Text messages sent, parsed. */
  json(): Record<string, unknown>[] {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }
  /** Sequence numbers of the audio messages sent. */
  sequences(): number[] {
    return this.sent
      .filter((data): data is ArrayBuffer => typeof data !== "string")
      .map((data) => new DataView(data).getUint32(0, true));
  }
}

const ready = {
  type: "ready",
  version: 1,
  maxSamples: 960_000,
  maxFrameSamples: 3_200,
  windowSamples: 16_000,
};

/** A connection over the fake socket, with failures recorded. */
function connection(context: TestContext, finalTimeoutMs = 30_000) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => {
    globalThis.WebSocket = original;
    mock.timers.reset();
  });
  const failures: string[] = [];
  const stream = new VoiceStreamConnection(
    "ws://localhost/v1/agents/a/voice/stream",
    {
      finalTimeoutMs,
      onFailure: (error) => failures.push(error.notice),
    },
  );
  stream.open();
  const socket = FakeSocket.last!;
  return { stream, socket, failures };
}

/** A connection that has opened and received ready. */
function streaming(context: TestContext, finalTimeoutMs?: number) {
  const fixture = connection(context, finalTimeoutMs);
  fixture.socket.open();
  fixture.socket.reply(ready);
  return fixture;
}

/** The notice a rejected promise carries. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof VoiceInputError);
    return error.notice;
  }
  assert.fail("Expected a rejection");
}

const frame = (samples = 320) => new Int16Array(samples);

test("sends start on open, frames within the window, then end with the counted totals and returns the final", async (context) => {
  const { stream, socket } = connection(context);
  stream.write(frame());
  assert.deepEqual(socket.sent, []);
  socket.open();
  assert.deepEqual(socket.json(), [
    {
      type: "start",
      version: 1,
      sampleRate: 16000,
      channels: 1,
      format: "pcm_s16le",
    },
  ]);
  socket.reply(ready);
  stream.write(frame(17));
  assert.deepEqual(socket.sequences(), [0, 1]);
  const finished = stream.finish(337);
  assert.deepEqual(socket.json().at(-1), {
    type: "end",
    sequence: 2,
    totalSamples: 337,
  });
  socket.reply({ type: "final", text: "Stable words." });
  assert.equal(await finished, "Stable words.");
  // Duplicate completion calls share the first result.
  assert.equal(await stream.finish(337), "Stable words.");
});

test("frames beyond the acknowledgement window wait for credit, and end waits for every frame", async (context) => {
  const { stream, socket } = streaming(context);
  for (let index = 0; index < 60; index++) stream.write(frame());
  // 16,000 samples is 50 frames of 320.
  assert.equal(socket.sequences().length, 50);
  const finished = stream.finish(60 * 320);
  assert.ok(!socket.json().some((message) => message.type === "end"));
  socket.reply({ type: "ack", sequence: 9 });
  assert.equal(socket.sequences().length, 60);
  assert.deepEqual(socket.json().at(-1), {
    type: "end",
    sequence: 60,
    totalSamples: 19_200,
  });
  socket.reply({ type: "final", text: "" });
  assert.equal(await finished, "");
});

test("a stalled acknowledgement while frames wait settles finish at the client's own deadline", async (context) => {
  const { stream, socket } = streaming(context, 30_000);
  for (let index = 0; index < 60; index++) stream.write(frame());
  const finished = stream.finish(60 * 320);
  mock.timers.tick(29_999);
  assert.ok(!socket.json().some((message) => message.type === "end"));
  mock.timers.tick(1);
  assert.equal(await rejection(finished), "timedOut");
  // No end was forced with frames missing; the stream was cancelled instead.
  assert.ok(!socket.json().some((message) => message.type === "end"));
  assert.deepEqual(socket.json().at(-1), { type: "cancel" });
});

test("a full WebSocket buffer pauses sending, resumes when it drains, and is bounded by the deadline", async (context) => {
  const { stream, socket } = streaming(context, 10_000);
  socket.bufferedAmount = 200 * 1024;
  stream.write(frame());
  assert.deepEqual(socket.sequences(), []);
  mock.timers.tick(20);
  assert.deepEqual(socket.sequences(), []);
  socket.bufferedAmount = 0;
  mock.timers.tick(20);
  assert.deepEqual(socket.sequences(), [0]);
  socket.bufferedAmount = 200 * 1024;
  stream.write(frame());
  const finished = stream.finish(640);
  mock.timers.tick(10_000);
  assert.equal(await rejection(finished), "timedOut");
  assert.deepEqual(socket.sequences(), [0]);
});

test("the pending queue is bounded and overflowing it fails the recording instead of dropping audio", (context) => {
  const { stream } = connection(context);
  for (let index = 0; index < 20; index++) stream.write(frame(3_200));
  assert.throws(
    () => stream.write(frame(1)),
    (error) =>
      error instanceof VoiceInputError && error.notice === "fellBehind",
  );
});

test("cancelling settles a pending finish as cancelled in every stage, and late messages do nothing", async (context) => {
  // While connecting.
  const connecting = connection(context);
  connecting.stream.write(frame());
  const early = connecting.stream.finish(320);
  connecting.stream.cancel();
  assert.equal(await rejection(early), "cancelled");
  // A late open after cancellation sends nothing.
  connecting.socket.open();
  assert.deepEqual(connecting.socket.sent, []);
  mock.timers.reset();

  // While frames wait for credit.
  const draining = streaming(context);
  for (let index = 0; index < 60; index++) draining.stream.write(frame());
  const waiting = draining.stream.finish(60 * 320);
  draining.stream.cancel();
  draining.stream.cancel();
  assert.equal(await rejection(waiting), "cancelled");
  assert.deepEqual(draining.socket.json().at(-1), { type: "cancel" });
  mock.timers.reset();

  // While awaiting the final; a late final is ignored.
  const ending = streaming(context);
  ending.stream.write(frame());
  const final = ending.stream.finish(320);
  ending.stream.cancel();
  assert.equal(await rejection(final), "cancelled");
  ending.socket.reply({ type: "final", text: "stale" });
  assert.deepEqual(ending.failures, []);
  assert.equal(await rejection(ending.stream.finish(320)), "cancelled");
});

test("service errors, unexpected closes, and mismatched totals end the stream with their outcome", async (context) => {
  for (const [code, notice] of [
    ["BUSY", "busy"],
    ["BACKPRESSURE", "fellBehind"],
    ["TIMEOUT", "timedOut"],
    ["UNAVAILABLE", "unavailable"],
  ] as const) {
    const fixture = streaming(context);
    fixture.socket.reply({ type: "error", code });
    assert.deepEqual(fixture.failures, [notice]);
    mock.timers.reset();
  }
  const closed = streaming(context);
  const finished = closed.stream.finish(0);
  closed.socket.onclose?.();
  assert.equal(await rejection(finished), "unavailable");
  mock.timers.reset();

  const mismatch = streaming(context);
  mismatch.stream.write(frame());
  assert.equal(await rejection(mismatch.stream.finish(319)), "fellBehind");
  mock.timers.reset();

  const refused = connection(context);
  mock.timers.tick(10_000);
  assert.deepEqual(refused.failures, ["unavailable"]);
});

test("acknowledgements that go backwards or ahead, and a final before end, are protocol failures", (context) => {
  const ahead = streaming(context);
  ahead.stream.write(frame());
  ahead.socket.reply({ type: "ack", sequence: 1 });
  assert.deepEqual(ahead.failures, ["failed"]);
  mock.timers.reset();
  const early = streaming(context);
  early.socket.reply({ type: "final", text: "too soon" });
  assert.deepEqual(early.failures, ["failed"]);
});
