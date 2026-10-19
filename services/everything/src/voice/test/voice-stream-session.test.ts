import assert from "node:assert/strict";
import { mock, test, type TestContext } from "node:test";
import {
  encodeVoiceFrame,
  voiceStreamStart,
  voiceStreamStartFor,
  type VoiceStreamVersion,
} from "@everything/conversation-contracts/voice-stream";
import type {
  SpeechStreamChannel,
  SpeechStreams,
  StreamListener,
} from "../interface/speech-streams.js";
import {
  VoiceStreamSession,
  type StreamTiming,
} from "../service/voice-stream-session.js";

const timing: StreamTiming = {
  startTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  finalTimeoutMs: 30_000,
  cleanupTimeoutMs: 10_000,
};

const ready = {
  type: "ready",
  version: 1,
  maxSamples: 960_000,
  maxFrameSamples: 3_200,
  windowSamples: 16_000,
};

/** A channel that records what is sent to it. */
class FakeChannel implements SpeechStreamChannel {
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  bufferedAmount = 0;
  live = false;
  send(message: string | Uint8Array): void {
    if (!this.closed) this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  /** Text messages sent, parsed. */
  json(): Record<string, unknown>[] {
    return this.sent
      .filter((message): message is string => typeof message === "string")
      .map((message) => JSON.parse(message) as Record<string, unknown>);
  }
  /** Binary messages sent. */
  binary(): Uint8Array[] {
    return this.sent.filter(
      (message): message is Uint8Array => typeof message !== "string",
    );
  }
}

/**
 * A stream session with fake browser and service connections: the browser agreed on `version`, and
 * the service says it speaks version 2 when `live`.
 */
function session(
  options: {
    connectFails?: boolean;
    version?: VoiceStreamVersion;
    live?: boolean;
  } = {},
) {
  const browser = new FakeChannel();
  const service = new FakeChannel();
  service.live = !!options.live;
  let listener: StreamListener | undefined;
  let connected: (channel: SpeechStreamChannel) => void = () => undefined;
  let connectSignal: AbortSignal | undefined;
  const streams: SpeechStreams = {
    connect: (events, signal) => {
      listener = events;
      connectSignal = signal;
      return options.connectFails
        ? Promise.reject(new Error("unreachable"))
        : new Promise((resolve) => (connected = resolve));
    },
  };
  let finished = 0;
  const stream = new VoiceStreamSession(
    browser,
    streams,
    timing,
    () => finished++,
    options.version,
  );
  return {
    stream,
    browser,
    service,
    /** Finish connecting to the service. */
    connect: async () => {
      connected(service);
      await settle();
    },
    /** A message from the service. */
    reply: (message: unknown) =>
      listener!.message(
        typeof message === "string" ? message : JSON.stringify(message),
      ),
    serviceCloses: () => listener!.closed(),
    finished: () => finished,
    connectSignal: () => connectSignal,
  };
}

/** Send a text message from the browser. */
function text(target: VoiceStreamSession, message: unknown): void {
  target.fromBrowser(
    Buffer.from(
      typeof message === "string" ? message : JSON.stringify(message),
    ),
    false,
  );
}

/** Send an audio message from the browser. */
function audio(
  target: VoiceStreamSession,
  sequence: number,
  samples: number,
): void {
  target.fromBrowser(
    new Uint8Array(encodeVoiceFrame(sequence, new Int16Array(samples))),
    true,
  );
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A session that has started and received ready. */
async function streaming(context: TestContext) {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const fixture = session();
  text(fixture.stream, voiceStreamStart);
  await fixture.connect();
  assert.deepEqual(fixture.service.json(), [voiceStreamStart]);
  fixture.reply(ready);
  assert.deepEqual(fixture.browser.json(), [ready]);
  return fixture;
}

/** The last message the browser received. */
const lastToBrowser = (fixture: { browser: FakeChannel }) =>
  fixture.browser.json().at(-1);

/** A version 2 browser's session that has started and received ready. */
async function liveStreaming(context: TestContext, live = true) {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const fixture = session({ version: 2, live });
  text(fixture.stream, voiceStreamStartFor(2));
  await fixture.connect();
  fixture.reply({ ...ready, version: live ? 2 : 1 });
  assert.deepEqual(fixture.browser.json(), [{ ...ready, version: 2 }]);
  return fixture;
}

test("relays a stream in order, crediting acknowledgements, and finishes once with the final", async (context) => {
  const fixture = await streaming(context);
  for (let sequence = 0; sequence < 5; sequence++)
    audio(fixture.stream, sequence, 320);
  audio(fixture.stream, 5, 17);
  assert.equal(fixture.service.binary().length, 6);
  assert.deepEqual(
    fixture.service
      .binary()
      .map((frame) =>
        new DataView(frame.buffer, frame.byteOffset).getUint32(0, true),
      ),
    [0, 1, 2, 3, 4, 5],
  );
  fixture.reply({ type: "ack", sequence: 2 });
  fixture.reply({ type: "ack", sequence: 2 });
  fixture.reply({ type: "ack", sequence: 5 });
  assert.deepEqual(
    fixture.browser.json().filter((message) => message.type === "ack"),
    [
      { type: "ack", sequence: 2 },
      { type: "ack", sequence: 5 },
    ],
  );
  text(fixture.stream, {
    type: "end",
    sequence: 6,
    totalSamples: 5 * 320 + 17,
  });
  assert.deepEqual(fixture.service.json().at(-1), {
    type: "end",
    sequence: 6,
    totalSamples: 1617,
  });
  assert.equal(fixture.finished(), 0);
  fixture.reply({ type: "final", text: "Stable final transcript." });
  assert.deepEqual(lastToBrowser(fixture), {
    type: "final",
    text: "Stable final transcript.",
  });
  assert.equal(fixture.browser.closed, true);
  assert.equal(fixture.service.closed, true);
  assert.equal(fixture.finished(), 1);
  // Nothing after the final is relayed.
  fixture.reply({ type: "final", text: "again" });
  fixture.serviceCloses();
  assert.equal(fixture.finished(), 1);
});

test("an immediate end with no audio yields the service's empty final", async (context) => {
  const fixture = await streaming(context);
  text(fixture.stream, { type: "end", sequence: 0, totalSamples: 0 });
  fixture.reply({ type: "final", text: "" });
  assert.deepEqual(lastToBrowser(fixture), { type: "final", text: "" });
  assert.equal(fixture.finished(), 1);
});

test("refuses invalid browser input with its code and cancels the service's work", async (context) => {
  for (const [name, act, code] of [
    [
      "gap",
      (s: VoiceStreamSession) => {
        audio(s, 0, 320);
        audio(s, 2, 320);
      },
      "INVALID_SEQUENCE",
    ],
    [
      "duplicate",
      (s: VoiceStreamSession) => {
        audio(s, 0, 320);
        audio(s, 0, 320);
      },
      "INVALID_SEQUENCE",
    ],
    [
      "out of order",
      (s: VoiceStreamSession) => audio(s, 1, 320),
      "INVALID_SEQUENCE",
    ],
    [
      "odd length",
      (s: VoiceStreamSession) => s.fromBrowser(new Uint8Array(7), true),
      "INVALID_AUDIO",
    ],
    [
      "no samples",
      (s: VoiceStreamSession) => s.fromBrowser(new Uint8Array(4), true),
      "INVALID_AUDIO",
    ],
    [
      "oversized",
      (s: VoiceStreamSession) => s.fromBrowser(new Uint8Array(6406), true),
      "INVALID_AUDIO",
    ],
    [
      "window",
      (s: VoiceStreamSession) => {
        for (let i = 0; i < 6; i++) audio(s, i, 3_200);
      },
      "BACKPRESSURE",
    ],
    [
      "end sequence",
      (s: VoiceStreamSession) => {
        audio(s, 0, 320);
        text(s, { type: "end", sequence: 0, totalSamples: 320 });
      },
      "INVALID_SEQUENCE",
    ],
    [
      "end samples",
      (s: VoiceStreamSession) => {
        audio(s, 0, 320);
        text(s, { type: "end", sequence: 1, totalSamples: 321 });
      },
      "INVALID_AUDIO",
    ],
    [
      "second start",
      (s: VoiceStreamSession) => text(s, voiceStreamStart),
      "INVALID_MESSAGE",
    ],
    [
      "unknown type",
      (s: VoiceStreamSession) => text(s, { type: "pause" }),
      "INVALID_MESSAGE",
    ],
    [
      "extra field",
      (s: VoiceStreamSession) => text(s, { type: "cancel", now: true }),
      "INVALID_MESSAGE",
    ],
    [
      "malformed",
      (s: VoiceStreamSession) => text(s, "{not json"),
      "INVALID_MESSAGE",
    ],
    [
      "large control",
      (s: VoiceStreamSession) =>
        text(s, {
          type: "end",
          sequence: 0,
          totalSamples: 0,
          pad: "x".repeat(1_100),
        }),
      "INVALID_MESSAGE",
    ],
  ] as const) {
    const fixture = await streaming(context);
    act(fixture.stream);
    assert.deepEqual(lastToBrowser(fixture), { type: "error", code }, name);
    assert.equal(fixture.browser.closed, true, name);
    assert.deepEqual(fixture.service.json().at(-1), { type: "cancel" }, name);
    // The places stay held until the service confirms its work stopped.
    assert.equal(fixture.finished(), 0, name);
    fixture.reply({ type: "cancelled" });
    assert.equal(fixture.finished(), 1, name);
    assert.equal(fixture.service.closed, true, name);
    mock.timers.reset();
  }
});

test("audio before ready, audio after end, and too many controls are refused", async (context) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const early = session();
  audio(early.stream, 0, 320);
  assert.deepEqual(lastToBrowser(early), {
    type: "error",
    code: "INVALID_MESSAGE",
  });
  assert.equal(early.finished(), 1);
  mock.timers.reset();

  const late = await streaming(context);
  text(late.stream, { type: "end", sequence: 0, totalSamples: 0 });
  audio(late.stream, 0, 320);
  assert.deepEqual(lastToBrowser(late), {
    type: "error",
    code: "INVALID_MESSAGE",
  });
  assert.deepEqual(late.service.json().at(-1), { type: "cancel" });
});

test("enforces the 60-second sample limit by counted samples", async (context) => {
  const fixture = await streaming(context);
  let sequence = 0;
  for (; sequence < 300; sequence++) {
    audio(fixture.stream, sequence, 3_200);
    fixture.reply({ type: "ack", sequence });
  }
  // Exactly 960,000 samples are accepted; one more is too long.
  assert.notEqual(lastToBrowser(fixture)?.type, "error");
  audio(fixture.stream, sequence, 1);
  assert.deepEqual(lastToBrowser(fixture), { type: "error", code: "TOO_LONG" });
});

test("fails with backpressure when the service stops reading", async (context) => {
  const fixture = await streaming(context);
  fixture.service.bufferedAmount = 200 * 1024;
  audio(fixture.stream, 0, 320);
  assert.deepEqual(lastToBrowser(fixture), {
    type: "error",
    code: "BACKPRESSURE",
  });
});

test("treats service protocol violations as unavailable and cancels", async (context) => {
  for (const [name, act] of [
    [
      "ack ahead",
      (f: Awaited<ReturnType<typeof streaming>>) =>
        f.reply({ type: "ack", sequence: 1 }),
    ],
    [
      "ack backwards",
      (f: Awaited<ReturnType<typeof streaming>>) => {
        f.reply({ type: "ack", sequence: 0 });
        audio(f.stream, 1, 320);
        f.reply({ type: "ack", sequence: -1 });
      },
    ],
    [
      "second ready",
      (f: Awaited<ReturnType<typeof streaming>>) => f.reply(ready),
    ],
    [
      "final before end",
      (f: Awaited<ReturnType<typeof streaming>>) =>
        f.reply({ type: "final", text: "early" }),
    ],
    [
      "unrequested cancelled",
      (f: Awaited<ReturnType<typeof streaming>>) =>
        f.reply({ type: "cancelled" }),
    ],
    [
      "binary",
      (f: Awaited<ReturnType<typeof streaming>>) =>
        f.reply(new Uint8Array(4) as unknown as string),
    ],
    [
      "unknown error",
      (f: Awaited<ReturnType<typeof streaming>>) =>
        f.reply({ type: "error", code: "NATIVE_PANIC", detail: "/models/x" }),
    ],
    [
      "raised limit",
      (f: Awaited<ReturnType<typeof streaming>>) =>
        f.reply({ ...ready, windowSamples: 99_999 }),
    ],
  ] as const) {
    const fixture = await streaming(context);
    audio(fixture.stream, 0, 320);
    act(fixture);
    assert.deepEqual(
      lastToBrowser(fixture),
      { type: "error", code: "UNAVAILABLE" },
      name,
    );
    assert.deepEqual(fixture.service.json().at(-1), { type: "cancel" }, name);
    mock.timers.reset();
  }
  const long = await streaming(context);
  text(long.stream, { type: "end", sequence: 0, totalSamples: 0 });
  long.reply({ type: "final", text: "x".repeat(32_001) });
  assert.deepEqual(lastToBrowser(long), { type: "error", code: "UNAVAILABLE" });
});

test("relays allowlisted service errors and ends the stream", async (context) => {
  const fixture = await streaming(context);
  fixture.reply({ type: "error", code: "BUSY" });
  assert.deepEqual(lastToBrowser(fixture), { type: "error", code: "BUSY" });
  assert.equal(fixture.finished(), 1);
  assert.equal(fixture.browser.closed, true);
});

test("a browser cancel waits for the service's confirmation and drops any late transcript", async (context) => {
  const fixture = await streaming(context);
  audio(fixture.stream, 0, 320);
  text(fixture.stream, { type: "cancel" });
  assert.deepEqual(fixture.service.json().at(-1), { type: "cancel" });
  fixture.reply({ type: "ack", sequence: 0 });
  fixture.reply({ type: "final", text: "stale words" });
  assert.ok(
    !fixture.browser.json().some((message) => message.type === "final"),
  );
  assert.equal(fixture.finished(), 1);
  mock.timers.reset();
  const second = await streaming(context);
  text(second.stream, { type: "cancel" });
  second.reply({ type: "cancelled" });
  assert.deepEqual(lastToBrowser(second), { type: "cancelled" });
  assert.equal(second.finished(), 1);
});

test("a browser disconnect cancels and holds the places until confirmation or the cleanup deadline", async (context) => {
  const fixture = await streaming(context);
  audio(fixture.stream, 0, 320);
  fixture.stream.browserClosed();
  assert.deepEqual(fixture.service.json().at(-1), { type: "cancel" });
  mock.timers.tick(9_999);
  assert.equal(fixture.finished(), 0);
  mock.timers.tick(1);
  assert.equal(fixture.finished(), 1);
  assert.equal(fixture.service.closed, true);
});

test("an unexpected service disconnect fails the stream", async (context) => {
  const fixture = await streaming(context);
  audio(fixture.stream, 0, 320);
  fixture.serviceCloses();
  assert.deepEqual(lastToBrowser(fixture), {
    type: "error",
    code: "UNAVAILABLE",
  });
  assert.equal(fixture.finished(), 1);
});

test("start, idle, and final deadlines fail the stream with a timeout", async (context) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const noStart = session();
  mock.timers.tick(5_000);
  assert.deepEqual(lastToBrowser(noStart), { type: "error", code: "TIMEOUT" });
  assert.equal(noStart.finished(), 1);
  mock.timers.reset();

  const idle = await streaming(context);
  audio(idle.stream, 0, 320);
  mock.timers.tick(4_999);
  audio(idle.stream, 1, 320);
  mock.timers.tick(4_999);
  assert.notEqual(lastToBrowser(idle)?.type, "error");
  mock.timers.tick(1);
  assert.deepEqual(lastToBrowser(idle), { type: "error", code: "TIMEOUT" });
  mock.timers.reset();

  const final = await streaming(context);
  text(final.stream, { type: "end", sequence: 0, totalSamples: 0 });
  mock.timers.tick(29_999);
  assert.notEqual(lastToBrowser(final)?.type, "error");
  mock.timers.tick(1);
  assert.deepEqual(lastToBrowser(final), { type: "error", code: "TIMEOUT" });
  assert.deepEqual(final.service.json().at(-1), { type: "cancel" });
});

test("an unreachable service fails at once, and a cancel before connecting sends nothing", async (context) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const unreachable = session({ connectFails: true });
  text(unreachable.stream, voiceStreamStart);
  await settle();
  assert.deepEqual(lastToBrowser(unreachable), {
    type: "error",
    code: "UNAVAILABLE",
  });
  assert.equal(unreachable.finished(), 1);

  const early = session();
  text(early.stream, voiceStreamStart);
  text(early.stream, { type: "cancel" });
  assert.equal(early.connectSignal()?.aborted, true);
  assert.deepEqual(lastToBrowser(early), { type: "cancelled" });
  assert.equal(early.finished(), 1);
  await early.connect();
  assert.deepEqual(early.service.sent, []);
  assert.equal(early.service.closed, true);
});

test("shutdown fails a running stream and still waits for the service's confirmation", async (context) => {
  const fixture = await streaming(context);
  fixture.stream.shutdown();
  assert.deepEqual(lastToBrowser(fixture), {
    type: "error",
    code: "UNAVAILABLE",
  });
  assert.deepEqual(fixture.service.json().at(-1), { type: "cancel" });
  fixture.reply({ type: "cancelled" });
  assert.equal(fixture.finished(), 1);
});

// ===========================================
// Version 2: partial transcripts
// ===========================================

test("a version 2 browser streams version 2 to a live service and gets its partials, then one final", async (context) => {
  const fixture = await liveStreaming(context);
  assert.deepEqual(fixture.service.json(), [voiceStreamStartFor(2)]);
  audio(fixture.stream, 0, 320);
  fixture.reply({ type: "partial", revision: 1, text: "Hel" });
  fixture.reply({ type: "ack", sequence: 0 });
  audio(fixture.stream, 1, 320);
  fixture.reply({ type: "partial", revision: 2, text: "Hello there" });
  text(fixture.stream, { type: "end", sequence: 2, totalSamples: 640 });
  // Partials and acknowledgements for audio before end still arrive before the final.
  fixture.reply({ type: "partial", revision: 4, text: "Hello there," });
  fixture.reply({ type: "ack", sequence: 1 });
  fixture.reply({ type: "final", text: "Hello there, friend." });
  assert.deepEqual(fixture.browser.json().slice(1), [
    { type: "partial", revision: 1, text: "Hel" },
    { type: "ack", sequence: 0 },
    { type: "partial", revision: 2, text: "Hello there" },
    { type: "partial", revision: 4, text: "Hello there," },
    { type: "ack", sequence: 1 },
    { type: "final", text: "Hello there, friend." },
  ]);
  assert.equal(fixture.finished(), 1);
});

test("a version 2 browser with a version 1 service gets ready 2 and only the final; the service sees version 1", async (context) => {
  const fixture = await liveStreaming(context, false);
  assert.deepEqual(fixture.service.json(), [voiceStreamStart]);
  audio(fixture.stream, 0, 320);
  fixture.reply({ type: "ack", sequence: 0 });
  text(fixture.stream, { type: "end", sequence: 1, totalSamples: 320 });
  fixture.reply({ type: "final", text: "Final only." });
  assert.deepEqual(lastToBrowser(fixture), {
    type: "final",
    text: "Final only.",
  });
  // A partial from a service that agreed on version 1 breaks the protocol.
  mock.timers.reset();
  const rogue = await liveStreaming(context, false);
  rogue.reply({ type: "partial", revision: 1, text: "unasked" });
  assert.deepEqual(lastToBrowser(rogue), {
    type: "error",
    code: "UNAVAILABLE",
  });
  assert.deepEqual(rogue.service.json().at(-1), { type: "cancel" });
});

test("a version 1 browser starts version 1 even with a live service, and never sees a partial", async (context) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const fixture = session({ version: 1, live: true });
  text(fixture.stream, voiceStreamStart);
  await fixture.connect();
  assert.deepEqual(fixture.service.json(), [voiceStreamStart]);
  fixture.reply(ready);
  fixture.reply({ type: "partial", revision: 1, text: "unasked" });
  assert.deepEqual(fixture.browser.json(), [
    ready,
    { type: "error", code: "UNAVAILABLE" },
  ]);
});

test("a start naming another version than the connection agreed on is refused", async (context) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  for (const [version, start] of [
    [1, voiceStreamStartFor(2)],
    [2, voiceStreamStart],
  ] as const) {
    const fixture = session({ version, live: true });
    text(fixture.stream, start);
    assert.deepEqual(lastToBrowser(fixture), {
      type: "error",
      code: "INVALID_MESSAGE",
    });
    assert.equal(fixture.finished(), 1);
    assert.equal(fixture.connectSignal(), undefined, "no service was asked");
  }
});

test("partials must only increase, fit the limits, and follow ready; after cancel they are dropped", async (context) => {
  for (const [name, act] of [
    [
      "repeated revision",
      (f: Awaited<ReturnType<typeof liveStreaming>>) => {
        f.reply({ type: "partial", revision: 2, text: "a" });
        f.reply({ type: "partial", revision: 2, text: "b" });
      },
    ],
    [
      "revision backwards",
      (f: Awaited<ReturnType<typeof liveStreaming>>) => {
        f.reply({ type: "partial", revision: 3, text: "a" });
        f.reply({ type: "partial", revision: 1, text: "b" });
      },
    ],
    [
      "revision zero",
      (f: Awaited<ReturnType<typeof liveStreaming>>) =>
        f.reply({ type: "partial", revision: 0, text: "a" }),
    ],
    [
      "revision past the message limit",
      (f: Awaited<ReturnType<typeof liveStreaming>>) =>
        f.reply({ type: "partial", revision: 6_001, text: "a" }),
    ],
    [
      "text too long",
      (f: Awaited<ReturnType<typeof liveStreaming>>) =>
        f.reply({ type: "partial", revision: 1, text: "x".repeat(32_001) }),
    ],
    [
      "extra field",
      (f: Awaited<ReturnType<typeof liveStreaming>>) =>
        f.reply({ type: "partial", revision: 1, text: "a", stable: true }),
    ],
  ] as const) {
    const fixture = await liveStreaming(context);
    act(fixture);
    assert.deepEqual(
      lastToBrowser(fixture),
      { type: "error", code: "UNAVAILABLE" },
      name,
    );
    mock.timers.reset();
  }
  // Before ready.
  mock.timers.enable({ apis: ["setTimeout"] });
  const early = session({ version: 2, live: true });
  text(early.stream, voiceStreamStartFor(2));
  await early.connect();
  early.reply({ type: "partial", revision: 1, text: "early" });
  assert.deepEqual(lastToBrowser(early), {
    type: "error",
    code: "UNAVAILABLE",
  });
  mock.timers.reset();
  // After a cancel, late partials are dropped while the service confirms.
  const cancelled = await liveStreaming(context);
  audio(cancelled.stream, 0, 320);
  text(cancelled.stream, { type: "cancel" });
  cancelled.reply({ type: "partial", revision: 1, text: "stale" });
  cancelled.reply({ type: "cancelled" });
  assert.ok(
    !cancelled.browser.json().some((message) => message.type === "partial"),
  );
  assert.deepEqual(lastToBrowser(cancelled), { type: "cancelled" });
});

test("a partial is skipped while the browser isn't reading, and the next one still arrives", async (context) => {
  const fixture = await liveStreaming(context);
  audio(fixture.stream, 0, 320);
  fixture.browser.bufferedAmount = 300 * 1024;
  fixture.reply({ type: "partial", revision: 1, text: "skipped" });
  fixture.browser.bufferedAmount = 0;
  fixture.reply({ type: "partial", revision: 2, text: "delivered" });
  assert.deepEqual(
    fixture.browser.json().filter((message) => message.type === "partial"),
    [{ type: "partial", revision: 2, text: "delivered" }],
  );
});
