import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VoiceCapacityError,
  VoiceUnavailableError,
} from "../error/voice-errors.js";
import { VoiceAdmission, type Release } from "../service/voice-admission.js";

/** Settle pending promise callbacks. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Whether a tracked entry has been admitted; a function, so assertions don't narrow the entry. */
const admitted = (entry: { release?: Release }): boolean => !!entry.release;

/** Track whether a queued entry has been admitted. */
function track(entry: Promise<Release>): {
  release?: Release;
  error?: unknown;
} {
  const state: { release?: Release; error?: unknown } = {};
  entry.then(
    (release) => (state.release = release),
    (error) => (state.error = error),
  );
  return state;
}

const never = new AbortController().signal;

test("runs up to the concurrency limit and admits queued work in arrival order", async () => {
  const admission = new VoiceAdmission({
    concurrency: 2,
    queueLimit: 2,
    queueTimeoutMs: 60_000,
  });
  const first = await admission.enter(never);
  const second = await admission.enter(never);
  const third = track(admission.enter(never));
  const fourth = track(admission.enter(never));
  await tick();
  assert.equal(admitted(third), false);
  await assert.rejects(admission.enter(never), VoiceCapacityError);
  first();
  first();
  await tick();
  assert.equal(admitted(third), true);
  assert.equal(admitted(fourth), false);
  second();
  await tick();
  assert.equal(admitted(fourth), true);
  third.release!();
  fourth.release!();
  // Every slot is free again.
  (await admission.enter(never))();
  (await admission.enter(never))();
});

test("a queued transcription leaves at its wait deadline or when its caller aborts", async () => {
  const admission = new VoiceAdmission({
    concurrency: 1,
    queueLimit: 1,
    queueTimeoutMs: 50,
  });
  const running = await admission.enter(never);
  await assert.rejects(admission.enter(never), VoiceCapacityError);
  const abort = new AbortController();
  const aborted = track(admission.enter(abort.signal));
  abort.abort();
  await tick();
  assert.ok(aborted.error instanceof VoiceUnavailableError);
  // The aborted waiter's place is free for another.
  const waiting = track(admission.enter(never));
  running();
  await tick();
  assert.equal(admitted(waiting), true);
  waiting.release!();
  await assert.rejects(
    admission.enter(AbortSignal.abort()),
    VoiceUnavailableError,
  );
});

test("closing refuses queued and future transcriptions", async () => {
  const admission = new VoiceAdmission({
    concurrency: 1,
    queueLimit: 4,
    queueTimeoutMs: 60_000,
  });
  const running = await admission.enter(never);
  const queued = track(admission.enter(never));
  admission.close();
  await tick();
  assert.ok(queued.error instanceof VoiceUnavailableError);
  await assert.rejects(admission.enter(never), VoiceUnavailableError);
  running();
});

test("a queue limit of zero refuses everything beyond the running slots", async () => {
  const admission = new VoiceAdmission({
    concurrency: 1,
    queueLimit: 0,
    queueTimeoutMs: 60_000,
  });
  const running = await admission.enter(never);
  await assert.rejects(admission.enter(never), VoiceCapacityError);
  running();
  (await admission.enter(never))();
});
