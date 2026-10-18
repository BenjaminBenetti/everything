import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentNotFoundError } from "../../agent/error/agent-errors.js";
import type { AgentDefinition } from "../../agent/model/agent.js";
import {
  VoiceBusyError,
  VoiceCapacityError,
  VoiceFormatError,
  VoiceRecordingTooLongError,
  VoiceUnavailableError,
} from "../error/voice-errors.js";
import type { AudioDecoder } from "../interface/audio-decoder.js";
import type { SpeechRecognizer } from "../interface/speech-recognizer.js";
import type { VoiceRecording } from "../interface/voice-operations.js";
import { VoiceAdmission } from "../service/voice-admission.js";
import { VoiceService } from "../service/voice-service.js";

const agentId = "6f1c1f6e-8c7e-4c4b-9a43-2d8b8f7c8f11";

/** A recording whose bytes carry the WebM signature. */
const recording: VoiceRecording = {
  contentType: "audio/webm;codecs=opus",
  bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 1, 2]),
};

/** Compose the service with recording fakes; each step can be replaced. */
function fixture(
  options: {
    available?: boolean;
    pcm?: Buffer;
    decode?: AudioDecoder["decode"];
    transcribe?: SpeechRecognizer["transcribe"];
    concurrency?: number;
    queueLimit?: number;
    reservations?: number;
  } = {},
) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const service = new VoiceService(
    {
      /** Only "owner", "second-owner", and "third-owner" can access the teammate. */
      async get(ownerId, id) {
        calls.push(`get:${ownerId}:${id}`);
        if (
          !["owner", "second-owner", "third-owner"].includes(ownerId) ||
          id !== agentId
        )
          throw new AgentNotFoundError();
        return { id } as AgentDefinition;
      },
    },
    {
      decode: async (audio, signal) => {
        calls.push(`decode:${audio.format.mediaType}`);
        signals.push(signal);
        return options.decode
          ? options.decode(audio, signal)
          : (options.pcm ?? Buffer.from([0, 64, 0, 64]));
      },
    },
    {
      available: options.available ?? true,
      transcribe: async (wave, signal) => {
        calls.push(`transcribe:${wave.length}`);
        signals.push(signal);
        return options.transcribe
          ? options.transcribe(wave, signal)
          : "  Draft this reply.  ";
      },
    },
    new VoiceAdmission({
      concurrency: options.concurrency ?? 1,
      queueLimit: options.queueLimit ?? 1,
      queueTimeoutMs: 60_000,
    }),
    { reservations: options.reservations ?? 2, responseTimeoutMs: 90_000 },
  );
  return { service, calls, signals };
}

const never = () => new AbortController().signal;

/** Hang until the signal aborts. */
function untilAborted(_wave: unknown, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(new Error("aborted"))),
  );
}

test("validates, checks ownership, decodes, then returns the trimmed transcript", async () => {
  const { service, calls } = fixture();
  const reservation = service.reserve("owner");
  assert.deepEqual(
    await service.transcribe(reservation, agentId, recording, never()),
    { text: "Draft this reply." },
  );
  assert.deepEqual(calls, [
    `get:owner:${agentId}`,
    "decode:audio/webm",
    "transcribe:48",
  ]);
  assert.deepEqual(service.capabilities(), {
    available: true,
    maxDurationMs: 60_000,
    maxBytes: 8 * 1024 * 1024,
    mediaTypes: ["audio/webm", "audio/ogg", "audio/mp4"],
    responseTimeoutMs: 90_000,
  });
});

test("reserves one recording per owner and a bounded total before any upload is read", () => {
  const { service } = fixture({ reservations: 2 });
  const first = service.reserve("owner");
  assert.throws(() => service.reserve("owner"), VoiceBusyError);
  const second = service.reserve("second-owner");
  assert.throws(() => service.reserve("third-owner"), VoiceCapacityError);
  first.release();
  first.release();
  // A stale release never frees the newer reservation that took the owner's place.
  const again = service.reserve("owner");
  first.release();
  assert.throws(() => service.reserve("owner"), VoiceBusyError);
  again.release();
  second.release();
  service.reserve("third-owner");
  const unavailable = fixture({ available: false });
  assert.throws(
    () => unavailable.service.reserve("owner"),
    VoiceUnavailableError,
  );
  assert.equal(unavailable.service.capabilities().available, false);
});

test("refuses released reservations, unaccepted formats, and inaccessible teammates before decoding", async () => {
  const { service, calls } = fixture();
  const released = service.reserve("owner");
  released.release();
  await assert.rejects(
    service.transcribe(released, agentId, recording, never()),
    VoiceUnavailableError,
  );
  const reservation = service.reserve("owner");
  await assert.rejects(
    service.transcribe(
      reservation,
      agentId,
      { contentType: "application/json", bytes: recording.bytes },
      never(),
    ),
    VoiceFormatError,
  );
  // Missing and foreign teammates are indistinguishable.
  await assert.rejects(
    service.transcribe(
      reservation,
      "4c1f8c2e-1d0b-4b1e-9d77-1f6f1c1f6e8c",
      recording,
      never(),
    ),
    AgentNotFoundError,
  );
  reservation.release();
  const intruder = service.reserve("intruder");
  await assert.rejects(
    service.transcribe(intruder, agentId, recording, never()),
    AgentNotFoundError,
  );
  assert.ok(!calls.some((call) => call.startsWith("decode")));
});

test("silent recordings return an empty transcript without reaching the speech service", async () => {
  const { service, calls } = fixture({ pcm: Buffer.from([0, 0, 16, 0]) });
  assert.deepEqual(
    await service.transcribe(
      service.reserve("owner"),
      agentId,
      recording,
      never(),
    ),
    { text: "" },
  );
  assert.ok(!calls.some((call) => call.startsWith("transcribe")));
});

test("failures reach the caller and leave the transcription slot free", async () => {
  const { service } = fixture({
    queueLimit: 0,
    transcribe: async () => {
      throw new VoiceRecordingTooLongError();
    },
  });
  const reservation = service.reserve("owner");
  await assert.rejects(
    service.transcribe(reservation, agentId, recording, never()),
    VoiceRecordingTooLongError,
  );
  // With no queue, a slot still held would refuse this at once.
  await assert.rejects(
    service.transcribe(reservation, agentId, recording, never()),
    VoiceRecordingTooLongError,
  );
});

test("a full transcription queue refuses at once, and a slot frees when its caller aborts", async () => {
  const { service, signals } = fixture({
    queueLimit: 0,
    reservations: 3,
    transcribe: untilAborted,
  });
  const ownerAbort = new AbortController();
  const running = service.transcribe(
    service.reserve("owner"),
    agentId,
    recording,
    ownerAbort.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    service.transcribe(
      service.reserve("second-owner"),
      agentId,
      recording,
      never(),
    ),
    VoiceCapacityError,
  );
  ownerAbort.abort();
  await assert.rejects(running, VoiceUnavailableError);
  assert.ok(signals.at(-1)?.aborted);
  // The freed slot admits the next transcription, which reaches the speech service.
  const reached = signals.length;
  const otherAbort = new AbortController();
  const other = service.transcribe(
    service.reserve("third-owner"),
    agentId,
    recording,
    otherAbort.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signals.length > reached);
  otherAbort.abort();
  await assert.rejects(other, VoiceUnavailableError);
});

test("closing aborts running transcriptions and refuses new ones", async () => {
  const { service, signals } = fixture({ transcribe: untilAborted });
  const running = service.transcribe(
    service.reserve("owner"),
    agentId,
    recording,
    never(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  service.close();
  await assert.rejects(running, VoiceUnavailableError);
  assert.ok(signals.at(-1)?.aborted);
  assert.throws(() => service.reserve("second-owner"), VoiceUnavailableError);
});
