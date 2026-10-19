import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type {
  MediaEnvironment,
  MediaRecorderLike,
} from "../interface/media-environment.js";
import { VoiceInputError } from "../model/voice-input-error.js";
import type { VoiceNotice } from "../model/voice-notice.js";
import {
  MicrophoneRecorder,
  type RecorderOptions,
} from "../service/microphone-recorder.js";
import { RecordingBuffer } from "../service/recording-buffer.js";

/** A microphone track that remembers being stopped. */
class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

/** A recorder that emits events like MediaRecorder: on stop, any final chunk, then `stop`. */
class FakeRecorder implements MediaRecorderLike {
  state = "inactive";
  timeslice: number | undefined;
  finalChunk: Blob | null = null;
  failOnStop = false;
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  constructor(readonly mimeType: string) {}

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      listener as (event?: unknown) => void,
    ]);
  }

  start(timeslice?: number): void {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    setImmediate(() => {
      if (this.failOnStop) return this.emit("error");
      if (this.finalChunk)
        this.emit("dataavailable", { data: this.finalChunk });
      this.emit("stop");
    });
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** A promise settled by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake microphone whose permission prompt the test answers. */
function environment(recorderType = "audio/webm;codecs=opus") {
  const tracks = [new FakeTrack(), new FakeTrack()];
  const permission = deferred<{ getTracks(): FakeTrack[] }>();
  const recorders: FakeRecorder[] = [];
  let createError: Error | null = null;
  const media: MediaEnvironment = {
    blocker: null,
    isTypeSupported: () => true,
    getUserMedia: () => permission.promise,
    createRecorder: (_stream, options) => {
      if (createError) throw createError;
      assert.equal(options.audioBitsPerSecond, 32_000);
      const recorder = new FakeRecorder(recorderType || options.mimeType);
      recorders.push(recorder);
      return recorder;
    },
  };
  return {
    media,
    tracks,
    recorders,
    grant: () => permission.resolve({ getTracks: () => tracks }),
    deny: (name: string) =>
      permission.reject(Object.assign(new Error(name), { name })),
    failCreate: (error: Error) => (createError = error),
  };
}

/** A recorder with recording callbacks captured for assertions. */
function recorder(
  media: MediaEnvironment,
  overrides: Partial<RecorderOptions> = {},
) {
  const sink = new RecordingBuffer();
  const failures: VoiceNotice[] = [];
  let limits = 0;
  const instance = new MicrophoneRecorder(media, sink, {
    type: "audio/webm;codecs=opus",
    maxBytes: 1_000,
    maxDurationMs: 59_500,
    onLimit: () => limits++,
    onFailure: (error) => failures.push(error.notice),
    ...overrides,
  });
  return { instance, sink, failures, limits: () => limits };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("records in one-second chunks and hands over the recorder's actual type when finished", async () => {
  const env = environment("audio/webm;codecs=opus");
  const { instance, sink } = recorder(env.media);
  const started = instance.start();
  env.grant();
  assert.equal(await started, true);
  const [fake] = env.recorders;
  assert.equal(fake?.timeslice, 1000);
  fake!.emit("dataavailable", { data: new Blob(["first-"]) });
  fake!.emit("dataavailable", { data: new Blob([]) });
  fake!.finalChunk = new Blob(["last"]);
  assert.deepEqual(await instance.finish(), { type: "audio/webm;codecs=opus" });
  const audio = sink.take("audio/webm;codecs=opus");
  assert.equal(await audio?.blob.text(), "first-last");
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.equal(sink.take("audio/webm"), null);
});

test("permission granted after release or cancel stops the tracks and never starts a recorder", async () => {
  for (const end of ["finish", "cancel"] as const) {
    const env = environment();
    const { instance } = recorder(env.media);
    const started = instance.start();
    if (end === "finish") assert.equal(await instance.finish(), null);
    else instance.cancel();
    env.grant();
    assert.equal(await started, false, end);
    assert.equal(env.recorders.length, 0, end);
    assert.ok(
      env.tracks.every((track) => track.stopped),
      end,
    );
  }
});

test("reports denied, missing, and failing microphones, and unsupported recorders", async () => {
  for (const [name, notice] of [
    ["NotAllowedError", "permissionDenied"],
    ["SecurityError", "permissionDenied"],
    ["NotFoundError", "noMicrophone"],
    ["NotReadableError", "microphoneFailed"],
    ["TypeError", "unsupported"],
  ] as const) {
    const env = environment();
    const started = recorder(env.media).instance.start();
    env.deny(name);
    await assert.rejects(
      started,
      (error) => error instanceof VoiceInputError && error.notice === notice,
      name,
    );
  }
  const env = environment();
  env.failCreate(new Error("NotSupportedError"));
  const started = recorder(env.media).instance.start();
  env.grant();
  await assert.rejects(
    started,
    (error) =>
      error instanceof VoiceInputError && error.notice === "unsupported",
  );
  assert.ok(env.tracks.every((track) => track.stopped));
});

test("a recording with no audio finishes empty", async () => {
  const env = environment();
  const { instance } = recorder(env.media);
  const started = instance.start();
  env.grant();
  await started;
  assert.equal(await instance.finish(), null);
  assert.ok(env.tracks.every((track) => track.stopped));
});

test("recorder errors and lost devices release the microphone and drop the audio", async () => {
  const env = environment();
  const { instance, sink, failures } = recorder(env.media);
  const started = instance.start();
  env.grant();
  await started;
  env.recorders[0]!.emit("dataavailable", { data: new Blob(["audio"]) });
  env.recorders[0]!.emit("error");
  assert.deepEqual(failures, ["microphoneFailed"]);
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.equal(sink.take("audio/webm"), null);
  // Later events are ignored and finishing reports nothing.
  env.recorders[0]!.emit("dataavailable", { data: new Blob(["late"]) });
  assert.equal(await instance.finish(), null);
  assert.deepEqual(failures, ["microphoneFailed"]);

  const lost = environment();
  const second = recorder(lost.media);
  const running = second.instance.start();
  lost.grant();
  await running;
  lost.recorders[0]!.emit("stop");
  assert.deepEqual(second.failures, ["microphoneFailed"]);
  assert.ok(lost.tracks.every((track) => track.stopped));
});

test("an error while stopping rejects the finish instead of reporting twice", async () => {
  const env = environment();
  const { instance, failures } = recorder(env.media);
  const started = instance.start();
  env.grant();
  await started;
  env.recorders[0]!.failOnStop = true;
  await assert.rejects(
    instance.finish(),
    (error) =>
      error instanceof VoiceInputError && error.notice === "microphoneFailed",
  );
  assert.deepEqual(failures, []);
  assert.ok(env.tracks.every((track) => track.stopped));
});

test("passing the size limit fails the recording and drops what was captured", async () => {
  const env = environment();
  const { instance, sink, failures } = recorder(env.media, { maxBytes: 10 });
  const started = instance.start();
  env.grant();
  await started;
  env.recorders[0]!.emit("dataavailable", { data: new Blob(["123456"]) });
  env.recorders[0]!.emit("dataavailable", { data: new Blob(["7890X"]) });
  assert.deepEqual(failures, ["tooLarge"]);
  assert.equal(sink.take("audio/webm"), null);
  assert.ok(env.tracks.every((track) => track.stopped));
});

test("reaching the duration limit asks for the recording to be finished, once", async (context) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => mock.timers.reset());
  const env = environment();
  const { instance, limits } = recorder(env.media, { maxDurationMs: 59_500 });
  const started = instance.start();
  env.grant();
  await started;
  mock.timers.tick(59_499);
  assert.equal(limits(), 0);
  mock.timers.tick(1);
  assert.equal(limits(), 1);
  mock.timers.tick(60_000);
  assert.equal(limits(), 1);
});

test("cancelling while recording or stopping drops the audio and stops every track", async () => {
  const env = environment();
  const { instance, sink, failures } = recorder(env.media);
  const started = instance.start();
  env.grant();
  await started;
  env.recorders[0]!.emit("dataavailable", { data: new Blob(["audio"]) });
  const finishing = instance.finish();
  instance.cancel();
  assert.equal(await finishing, null);
  await settle();
  assert.equal(sink.take("audio/webm"), null);
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.deepEqual(failures, []);
  instance.cancel();
});
