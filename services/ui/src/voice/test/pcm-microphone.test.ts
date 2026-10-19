import assert from "node:assert/strict";
import { mock, test, type TestContext } from "node:test";
import type {
  CaptureGraph,
  CapturePort,
  PcmCaptureEnvironment,
} from "../interface/pcm-capture.js";
import { VoiceInputError } from "../model/voice-input-error.js";
import type { VoiceNotice } from "../model/voice-notice.js";
import { PcmMicrophone } from "../service/pcm-microphone.js";

/** A worklet port the test drives. */
class FakePort implements CapturePort {
  readonly posted: Record<string, unknown>[] = [];
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  /** The worklet sent a message. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** A capture environment whose permission prompt, graph, and worklet the test controls. */
function environment(
  options: { sampleRate?: number; graphFails?: boolean } = {},
) {
  const stopped: boolean[] = [];
  let grant: () => void = () => undefined;
  let deny: (error: Error) => void = () => undefined;
  const port = new FakePort();
  const state = { graphClosed: false, graphsStarted: 0 };
  const capture: PcmCaptureEnvironment = {
    blocker: null,
    getUserMedia: () =>
      new Promise((resolve, reject) => {
        grant = () => {
          const index = stopped.push(false) - 1;
          resolve({
            getTracks: () => [{ stop: () => (stopped[index] = true) }],
          });
        };
        deny = reject;
      }),
    createGraph: (): CaptureGraph => ({
      sampleRate: options.sampleRate ?? 16_000,
      start: async () => {
        state.graphsStarted++;
        if (options.graphFails) throw new Error("addModule failed");
        return port;
      },
      close: () => (state.graphClosed = true),
    }),
  };
  return {
    capture,
    port,
    state,
    stopped,
    grant: () => grant(),
    deny: (error: Error) => deny(error),
  };
}

/** A microphone with frames and callbacks recorded. */
function microphone(
  capture: PcmCaptureEnvironment,
  write?: (samples: Int16Array) => void,
) {
  const frames: number[] = [];
  const failures: VoiceNotice[] = [];
  let limits = 0;
  const instance = new PcmMicrophone(
    capture,
    { write: write ?? ((samples) => frames.push(samples.length)) },
    {
      maxDurationMs: 59_500,
      onLimit: () => limits++,
      onFailure: (error) => failures.push(error.notice),
    },
  );
  return { instance, frames, failures, limits: () => limits };
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

/** Start capturing with permission granted. */
async function capturing(
  context: TestContext,
  options?: Parameters<typeof environment>[0],
) {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const env = environment(options);
  const mic = microphone(env.capture);
  const started = mic.instance.start();
  env.grant();
  assert.equal(await started, true);
  return { ...env, ...mic };
}

test("writes each frame in order, returns its credit, and finishes after the worklet confirms its last frame", async (context) => {
  const fixture = await capturing(context);
  fixture.port.emit({ type: "frame", samples: new Int16Array(320) });
  fixture.port.emit({ type: "frame", samples: new Int16Array(320) });
  const finished = fixture.instance.finish();
  assert.deepEqual(fixture.port.posted.at(-1), { type: "flush" });
  // The graph stays up until the worklet has handed over its short last frame.
  assert.equal(fixture.state.graphClosed, false);
  fixture.port.emit({ type: "frame", samples: new Int16Array(17) });
  fixture.port.emit({ type: "flushed", samples: 657 });
  assert.deepEqual(await finished, { samples: 657 });
  assert.deepEqual(fixture.frames, [320, 320, 17]);
  assert.equal(
    fixture.port.posted.filter((m) => m.type === "credit").length,
    3,
  );
  assert.equal(fixture.state.graphClosed, true);
  assert.deepEqual(fixture.stopped, [true]);
  assert.equal(fixture.instance.finish(), fixture.instance.finish());
});

test("permission arriving after a release or cancel starts no graph and stops the microphone", async () => {
  for (const end of ["finish", "cancel"] as const) {
    const env = environment();
    const mic = microphone(env.capture);
    const started = mic.instance.start();
    if (end === "finish") assert.equal(await mic.instance.finish(), null);
    else mic.instance.cancel();
    env.grant();
    assert.equal(await started, false, end);
    assert.equal(env.state.graphsStarted, 0, end);
    assert.deepEqual(env.stopped, [true], end);
  }
});

test("refuses a graph that doesn't run at 16 kHz, a failed worklet, and denied permission", async () => {
  for (const [options, notice] of [
    [{ sampleRate: 44_100 }, "unsupported"],
    [{ graphFails: true }, "microphoneFailed"],
  ] as const) {
    const env = environment(options);
    const started = microphone(env.capture).instance.start();
    env.grant();
    assert.equal(await rejection(started), notice);
    assert.deepEqual(env.stopped, [true]);
  }
  const denied = environment();
  const started = microphone(denied.capture).instance.start();
  denied.deny(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  assert.equal(await rejection(started), "permissionDenied");
});

test("a worklet overflow, a full transport queue, or a missing frame fails the whole recording", async (context) => {
  const overflow = await capturing(context);
  overflow.port.emit({ type: "overflow" });
  assert.deepEqual(overflow.failures, ["fellBehind"]);
  assert.deepEqual(overflow.port.posted.at(-1), { type: "stop" });
  assert.deepEqual(overflow.stopped, [true]);
  mock.timers.reset();

  const env = environment();
  mock.timers.enable({ apis: ["setTimeout"] });
  const full = microphone(env.capture, () => {
    throw new VoiceInputError("fellBehind");
  });
  const started = full.instance.start();
  env.grant();
  await started;
  env.port.emit({ type: "frame", samples: new Int16Array(320) });
  assert.deepEqual(full.failures, ["fellBehind"]);
  mock.timers.reset();

  const missing = await capturing(context);
  missing.port.emit({ type: "frame", samples: new Int16Array(320) });
  const finished = missing.instance.finish();
  missing.port.emit({ type: "flushed", samples: 640 });
  assert.equal(await rejection(finished), "fellBehind");
});

test("a flush the worklet never confirms fails within its deadline", async (context) => {
  const fixture = await capturing(context);
  const finished = fixture.instance.finish();
  mock.timers.tick(2_000);
  assert.equal(await rejection(finished), "microphoneFailed");
  assert.deepEqual(fixture.stopped, [true]);
});

test("the duration limit asks for a finish once, and cancelling drops later frames", async (context) => {
  const fixture = await capturing(context);
  mock.timers.tick(59_500);
  assert.equal(fixture.limits(), 1);
  const finished = fixture.instance.finish();
  fixture.instance.cancel();
  assert.equal(await finished, null);
  fixture.port.emit({ type: "frame", samples: new Int16Array(320) });
  assert.deepEqual(fixture.frames, []);
  assert.deepEqual(fixture.stopped, [true]);
  fixture.instance.cancel();
});

test("finishing or cancelling while the graph starts releases the microphone and graph at once", async () => {
  for (const [end, outcome] of [
    ["finish", "resolve"],
    ["finish", "reject"],
    ["cancel", "resolve"],
  ] as const) {
    const stopped: boolean[] = [];
    let closes = 0;
    let settle:
      | { resolve(port: CapturePort): void; reject(error: Error): void }
      | undefined;
    const port = new FakePort();
    const capture: PcmCaptureEnvironment = {
      blocker: null,
      getUserMedia: async () => ({
        getTracks: () => [{ stop: () => stopped.push(true) }],
      }),
      createGraph: () => ({
        sampleRate: 16_000,
        start: () =>
          new Promise((resolve, reject) => (settle = { resolve, reject })),
        close: () => closes++,
      }),
    };
    const mic = microphone(capture);
    const started = mic.instance.start();
    // Permission has resolved; the graph is still loading its worklet.
    for (let attempt = 0; attempt < 10 && !settle; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(settle, "graph start is pending");
    if (end === "finish") assert.equal(await mic.instance.finish(), null);
    else mic.instance.cancel();
    assert.deepEqual(stopped, [true], `${end}: tracks stopped at once`);
    assert.equal(closes, 1, `${end}: graph closed at once`);
    mic.instance.cancel();
    assert.equal(await mic.instance.finish(), null);
    if (outcome === "resolve") settle!.resolve(port);
    else settle!.reject(new Error("addModule failed"));
    assert.equal(await started, false, `${end}/${outcome}`);
    port.emit({ type: "frame", samples: new Int16Array(320) });
    assert.deepEqual(
      mic.frames,
      [],
      `${end}/${outcome}: no frames after release`,
    );
    assert.deepEqual(mic.failures, []);
    assert.deepEqual(stopped, [true], "no second stop");
    assert.ok(closes <= 1, "no second close");
    if (outcome === "resolve")
      assert.deepEqual(port.posted.at(-1), { type: "stop" });
  }
});
